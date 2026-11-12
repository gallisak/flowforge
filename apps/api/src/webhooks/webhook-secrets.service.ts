import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { EntityManager, IsNull, LessThanOrEqual, MoreThan } from 'typeorm';
import { API_CONFIG, ApiConfig } from '../config/config';
import { TenantDb } from '../db/tenant-db.service';
import { SecretPurpose, WebhookSecret } from '../entities';

export interface WebhookSecretSummary {
  id: string;
  createdAt: Date;
  expiresAt: Date | null;
}

export const MAX_ACTIVE_SECRETS = 3;

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64')}`;
}

const summary = ({ id, createdAt, expiresAt }: WebhookSecret): WebhookSecretSummary => ({ id, createdAt, expiresAt });

@Injectable()
export class WebhookSecretsService {
  constructor(
    private readonly db: TenantDb,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  activeSecrets(em: EntityManager, tenantId: string, purpose: SecretPurpose = 'inbound'): Promise<WebhookSecret[]> {
    const now = new Date();
    return em.find(WebhookSecret, {
      where: [
        { tenantId, purpose, expiresAt: IsNull() },
        { tenantId, purpose, expiresAt: MoreThan(now) },
      ],
    });
  }

  async create(em: EntityManager, tenantId: string, purpose: SecretPurpose = 'inbound'): Promise<WebhookSecret> {
    return em.save(em.create(WebhookSecret, { tenantId, purpose, secret: generateWebhookSecret(), expiresAt: null }));
  }

  list(tenantId: string, purpose: SecretPurpose = 'inbound'): Promise<WebhookSecretSummary[]> {
    return this.db.run(tenantId, async (em) => (await this.activeSecrets(em, tenantId, purpose)).map(summary));
  }

  rotate(tenantId: string, purpose: SecretPurpose = 'inbound'): Promise<WebhookSecretSummary & { secret: string }> {
    return this.db.run(tenantId, async (em) => {
      await em.query(`SELECT pg_advisory_xact_lock(hashtextextended('webhook-secrets:' || $1 || ':' || $2, 0))`, [tenantId, purpose]);
      const now = new Date();
      const graceEnds = new Date(now.getTime() + this.config.webhookSecretGraceSeconds * 1000);
      await em.delete(WebhookSecret, { tenantId, purpose, expiresAt: LessThanOrEqual(now) });
      await em.update(WebhookSecret, { tenantId, purpose, expiresAt: IsNull() }, { expiresAt: graceEnds });
      await em.update(WebhookSecret, { tenantId, purpose, expiresAt: MoreThan(graceEnds) }, { expiresAt: graceEnds });
      await em.query(
        `DELETE FROM webhook_secrets WHERE "tenantId" = $1 AND purpose = $2 AND id NOT IN (
           SELECT id FROM webhook_secrets WHERE "tenantId" = $1 AND purpose = $2 ORDER BY "createdAt" DESC, id DESC LIMIT $3)`,
        [tenantId, purpose, MAX_ACTIVE_SECRETS - 1],
      );
      const created = await this.create(em, tenantId, purpose);
      return { ...summary(created), secret: created.secret };
    });
  }

  revoke(tenantId: string, id: string, purpose: SecretPurpose = 'inbound'): Promise<void> {
    return this.db.run(tenantId, async (em) => {
      const { affected } = await em.delete(WebhookSecret, { tenantId, id, purpose });
      if (!affected) throw new NotFoundException('Signing secret not found');
    });
  }
}

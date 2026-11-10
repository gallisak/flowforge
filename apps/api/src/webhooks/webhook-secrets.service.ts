import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { EntityManager, IsNull, LessThanOrEqual, MoreThan } from 'typeorm';
import { API_CONFIG, ApiConfig } from '../config/config';
import { TenantDb } from '../db/tenant-db.service';
import { WebhookSecret } from '../entities';

export interface WebhookSecretSummary {
  id: string;
  createdAt: Date;
  expiresAt: Date | null;
}

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

  activeSecrets(em: EntityManager, tenantId: string): Promise<WebhookSecret[]> {
    const now = new Date();
    return em.find(WebhookSecret, {
      where: [
        { tenantId, expiresAt: IsNull() },
        { tenantId, expiresAt: MoreThan(now) },
      ],
    });
  }

  async create(em: EntityManager, tenantId: string): Promise<WebhookSecret> {
    return em.save(em.create(WebhookSecret, { tenantId, secret: generateWebhookSecret(), expiresAt: null }));
  }

  list(tenantId: string): Promise<WebhookSecretSummary[]> {
    return this.db.run(tenantId, async (em) => (await this.activeSecrets(em, tenantId)).map(summary));
  }

  rotate(tenantId: string): Promise<WebhookSecretSummary & { secret: string }> {
    return this.db.run(tenantId, async (em) => {
      const now = new Date();
      const graceEnds = new Date(now.getTime() + this.config.webhookSecretGraceSeconds * 1000);
      await em.delete(WebhookSecret, { tenantId, expiresAt: LessThanOrEqual(now) });
      await em.update(WebhookSecret, { tenantId, expiresAt: IsNull() }, { expiresAt: graceEnds });
      await em.update(WebhookSecret, { tenantId, expiresAt: MoreThan(graceEnds) }, { expiresAt: graceEnds });
      const created = await this.create(em, tenantId);
      return { ...summary(created), secret: created.secret };
    });
  }

  revoke(tenantId: string, id: string): Promise<void> {
    return this.db.run(tenantId, async (em) => {
      const { affected } = await em.delete(WebhookSecret, { tenantId, id });
      if (!affected) throw new NotFoundException('Webhook secret not found');
    });
  }
}

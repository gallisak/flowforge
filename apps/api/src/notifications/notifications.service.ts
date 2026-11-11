import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { NotificationEndpoint } from '../entities';
import { TenantDb } from '../db/tenant-db.service';
import { WebhookSecretsService } from '../webhooks/webhook-secrets.service';

export interface NotificationEndpointView {
  url: string;
  updatedAt: Date;
}

const view = ({ url, updatedAt }: NotificationEndpoint): NotificationEndpointView => ({ url, updatedAt });

function assertDeliverableUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.username || parsed.password) throw new BadRequestException('url must not contain credentials');
  if (parsed.hash) throw new BadRequestException('url must not contain a fragment');
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly db: TenantDb,
    private readonly secrets: WebhookSecretsService,
  ) {}

  get(tenantId: string): Promise<NotificationEndpointView> {
    return this.db.run(tenantId, async (em) => {
      const endpoint = await em.findOne(NotificationEndpoint, { where: { tenantId } });
      if (!endpoint) throw new NotFoundException('No notification endpoint is configured');
      return view(endpoint);
    });
  }

  set(tenantId: string, url: string): Promise<NotificationEndpointView & { secret?: string }> {
    assertDeliverableUrl(url);
    return this.db.run(tenantId, async (em) => {
      await em.upsert(NotificationEndpoint, { tenantId, url }, ['tenantId']);
      const endpoint = await em.findOneOrFail(NotificationEndpoint, { where: { tenantId } });
      const active = await this.secrets.activeSecrets(em, tenantId, 'outbound');
      if (active.length > 0) return view(endpoint);
      const created = await this.secrets.create(em, tenantId, 'outbound');
      return { ...view(endpoint), secret: created.secret };
    });
  }

  remove(tenantId: string): Promise<void> {
    return this.db.run(tenantId, async (em) => {
      const { affected } = await em.delete(NotificationEndpoint, { tenantId });
      if (!affected) throw new NotFoundException('No notification endpoint is configured');
    });
  }
}

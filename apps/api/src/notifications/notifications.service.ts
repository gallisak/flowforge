import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { isIP } from 'net';
import { API_CONFIG, ApiConfig } from '../config/config';
import { TenantDb } from '../db/tenant-db.service';
import { isPublicAddress, nonBlockingResolver, Resolver } from '../engine/http/safe-http';
import { NotificationEndpoint, OutboxEvent, OutboxEventStatus } from '../entities';
import { WebhookSecretsService } from '../webhooks/webhook-secrets.service';

export interface NotificationEndpointView {
  url: string;
  updatedAt: Date;
}

export type NotificationEventView = Pick<
  OutboxEvent,
  'id' | 'executionId' | 'type' | 'status' | 'attempts' | 'lastError' | 'lastStatusCode' | 'nextAttemptAt' | 'createdAt' | 'deliveredAt'
>;

const EVENT_COLUMNS: Array<keyof NotificationEventView> = [
  'id',
  'executionId',
  'type',
  'status',
  'attempts',
  'lastError',
  'lastStatusCode',
  'nextAttemptAt',
  'createdAt',
  'deliveredAt',
];
const DESTINATION_LOOKUP_TIMEOUT_MS = 1_000;
const NOT_PUBLIC = 'url must point to a public internet address';

const view = ({ url, updatedAt }: NotificationEndpoint): NotificationEndpointView => ({ url, updatedAt });

@Injectable()
export class NotificationsService {
  private readonly resolve: Resolver = nonBlockingResolver(DESTINATION_LOOKUP_TIMEOUT_MS);
  private readonly allowlist: Set<string>;

  constructor(
    private readonly db: TenantDb,
    private readonly secrets: WebhookSecretsService,
    @Inject(API_CONFIG) config: ApiConfig,
  ) {
    this.allowlist = new Set(config.ssrfAllowlist);
  }

  get(tenantId: string): Promise<NotificationEndpointView> {
    return this.db.run(tenantId, async (em) => {
      const endpoint = await em.findOne(NotificationEndpoint, { where: { tenantId } });
      if (!endpoint) throw new NotFoundException('No notification endpoint is configured');
      return view(endpoint);
    });
  }

  async set(tenantId: string, url: string): Promise<NotificationEndpointView & { secret?: string }> {
    await this.assertDeliverable(url);
    return this.db.run(tenantId, async (em) => {
      await this.secrets.lock(em, tenantId, 'outbound');
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

  events(tenantId: string, filter: { status?: OutboxEventStatus; limit?: number }): Promise<NotificationEventView[]> {
    return this.db.run(tenantId, (em) =>
      em.find(OutboxEvent, {
        select: EVENT_COLUMNS,
        where: { tenantId, ...(filter.status ? { status: filter.status } : {}) },
        order: { createdAt: 'DESC', id: 'DESC' },
        take: filter.limit ?? 20,
      }),
    );
  }

  private async assertDeliverable(url: string): Promise<void> {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) throw new BadRequestException('url must not contain credentials');
    if (parsed.hash) throw new BadRequestException('url must not contain a fragment');
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    if (this.allowlist.has(host) || this.allowlist.has(`${host}:${port}`)) return;
    const literal = host.replace(/^\[|\]$/g, '');
    if (isIP(literal)) {
      if (!isPublicAddress(literal)) throw new BadRequestException(NOT_PUBLIC);
      return;
    }
    const addresses = await this.resolve(host).catch(() => []);
    if (addresses.some((address) => !isPublicAddress(address.address))) throw new BadRequestException(NOT_PUBLIC);
  }
}

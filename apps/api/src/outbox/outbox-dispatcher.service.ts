import { BeforeApplicationShutdown, Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { IsNull, Raw } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { WORKER_CONFIG, WorkerConfig } from '../config/config';
import { TenantDb } from '../db/tenant-db.service';
import { retryDelayMs } from '../engine/job-queue.service';
import { findDestinationError, SafeHttpClient, SafeHttpResponse } from '../engine/http/safe-http';
import { NotificationEndpoint, OutboxEvent, WebhookSecret } from '../entities';
import { CORRELATION_HEADER } from '../observability/correlation';
import { runWithLogContext } from '../observability/log-context';
import { metrics } from '../observability/metrics';
import { webhookSignature } from '../webhooks/signature';

const USER_AGENT = 'FlowForge-Webhooks/1.0';

export interface NotificationTarget {
  url: string;
  secrets: string[];
}

export function notificationBody(event: Pick<OutboxEvent, 'type' | 'createdAt' | 'payload'>): string {
  return JSON.stringify({ type: event.type, timestamp: new Date(event.createdAt).toISOString(), data: event.payload });
}

export function notificationHeaders(
  event: Pick<OutboxEvent, 'id' | 'correlationId'>,
  body: string,
  secrets: readonly string[],
  nowSeconds: number,
): Record<string, string> {
  const timestamp = String(nowSeconds);
  const signature = secrets
    .map((secret) => `v1,${webhookSignature(secret, event.id, timestamp, Buffer.from(body)).toString('base64')}`)
    .join(' ');
  return {
    'content-type': 'application/json',
    'user-agent': USER_AGENT,
    'webhook-id': event.id,
    'webhook-timestamp': timestamp,
    'webhook-signature': signature,
    ...(event.correlationId ? { [CORRELATION_HEADER]: event.correlationId } : {}),
  };
}

type Outcome = { kind: 'delivered'; status: number } | { kind: 'retry'; error: string; status?: number } | { kind: 'dead'; error: string };

@Injectable()
export class OutboxDispatcher implements BeforeApplicationShutdown {
  private readonly logger = new Logger(OutboxDispatcher.name);
  readonly dispatcherId = `outbox-${randomUUID().slice(0, 8)}`;
  private readonly client: SafeHttpClient;
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly db: TenantDb,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
  ) {
    this.client = new SafeHttpClient({
      allowlist: config.ssrfAllowlist,
      timeoutMs: config.outbox.timeoutMs,
      maxRedirects: 0,
      maxResponseBytes: 0,
    });
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    await Promise.allSettled([...this.inFlight]);
    await this.client.close();
  }

  private async run(): Promise<void> {
    const { concurrency, tenantConcurrency, leaseSeconds, pollIntervalMs } = this.config.outbox;
    while (this.running) {
      const free = concurrency - this.inFlight.size;
      let claimed: OutboxEvent[] = [];
      if (free > 0) {
        try {
          claimed = await this.db.claimOutboxEvents(this.dispatcherId, leaseSeconds, free, tenantConcurrency);
        } catch (error) {
          this.logger.error(`outbox dispatcher error: ${(error as Error).message}`);
        }
      }
      for (const event of claimed) this.track(event);
      if (claimed.length === 0 || this.inFlight.size >= concurrency) await this.pause(pollIntervalMs);
    }
  }

  private track(event: OutboxEvent): void {
    const delivery = this.deliver(event)
      .catch((error: Error) => this.logger.error(`outbox delivery error: ${error.message}`))
      .finally(() => {
        this.inFlight.delete(delivery);
        this.wake?.();
      });
    this.inFlight.add(delivery);
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
    });
  }

  private deliver(event: OutboxEvent): Promise<void> {
    const context = {
      correlationId: event.correlationId ?? undefined,
      tenantId: event.tenantId,
      executionId: event.executionId,
      eventId: event.id,
      attempt: event.attempts,
    };
    return runWithLogContext(context, async () => {
      const outcome = await this.attempt(event);
      await this.record(event, outcome);
    });
  }

  private async attempt(event: OutboxEvent): Promise<Outcome> {
    if (event.attempts > this.config.outbox.maxAttempts) {
      return { kind: 'dead', error: `gave up after ${this.config.outbox.maxAttempts} attempts` };
    }
    const target = await this.targetOf(event.tenantId);
    if (!target) return { kind: 'dead', error: 'no notification endpoint is configured' };
    if (target.secrets.length === 0) return { kind: 'retry', error: 'no active signing secret' };

    const body = notificationBody(event);
    const headers = notificationHeaders(event, body, target.secrets, Math.floor(Date.now() / 1000));
    let response: SafeHttpResponse;
    try {
      response = await this.client.request(target.url, { method: 'POST', headers, body, discardResponseBody: true });
    } catch (error) {
      const blocked = findDestinationError(error);
      if (blocked) return { kind: 'dead', error: blocked.message };
      const name = (error as Error).name;
      const timedOut = name === 'TimeoutError' || name === 'HeadersTimeoutError' || name === 'BodyTimeoutError';
      return { kind: 'retry', error: timedOut ? 'delivery timed out' : 'delivery failed: connection error' };
    }
    if (response.status >= 200 && response.status <= 299) return { kind: 'delivered', status: response.status };
    return { kind: 'retry', error: `endpoint answered ${response.status}`, status: response.status };
  }

  private targetOf(tenantId: string): Promise<NotificationTarget | null> {
    return this.db.run(tenantId, async (em) => {
      const endpoint = await em.findOne(NotificationEndpoint, { where: { tenantId } });
      if (!endpoint) return null;
      const secrets = await em.find(WebhookSecret, {
        where: [
          { tenantId, purpose: 'outbound', expiresAt: IsNull() },
          { tenantId, purpose: 'outbound', expiresAt: Raw((column) => `${column} > now()`) },
        ],
        order: { createdAt: 'DESC' },
      });
      return { url: endpoint.url, secrets: secrets.map((s) => s.secret) };
    });
  }

  private async record(event: OutboxEvent, outcome: Outcome): Promise<void> {
    const released = { lockedBy: null, lockedUntil: null };
    let update: QueryDeepPartialEntity<OutboxEvent>;
    let label: 'delivered' | 'retry' | 'dead' = outcome.kind;
    if (outcome.kind === 'delivered') {
      update = { ...released, status: 'delivered', deliveredAt: () => 'now()', lastError: null, lastStatusCode: outcome.status };
    } else if (outcome.kind === 'retry' && event.attempts < this.config.outbox.maxAttempts) {
      const delaySeconds = retryDelayMs(event.attempts, { baseMs: this.config.outbox.retryBaseMs, capMs: this.config.outbox.retryCapMs }) / 1000;
      update = {
        ...released,
        status: 'pending',
        nextAttemptAt: () => `now() + make_interval(secs => ${Number(delaySeconds)})`,
        lastError: outcome.error,
        lastStatusCode: outcome.status ?? null,
      };
    } else {
      label = 'dead';
      update = { ...released, status: 'dead', lastError: outcome.error, lastStatusCode: outcome.kind === 'retry' ? (outcome.status ?? null) : null };
    }
    const result = await this.db.run(event.tenantId, (em) =>
      em.update(OutboxEvent, { id: event.id, lockedBy: this.dispatcherId, attempts: event.attempts, status: 'delivering' }, update),
    );
    if (result.affected !== 1) {
      this.logger.warn('notification lease was lost before its result was recorded');
      return;
    }
    metrics.outboxDeliveries.inc({ outcome: label });
    if (label === 'delivered') this.logger.log('notification delivered');
    else this.logger.warn(`notification ${label === 'dead' ? 'abandoned' : 'will be retried'}: ${'error' in outcome ? outcome.error : ''}`);
  }
}

import { BeforeApplicationShutdown, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Request, Response } from 'express';
import { API_CONFIG, ApiConfig } from '../config/config';
import { TooManyRequestsException } from '../limits/too-many-requests';
import { ExecutionEventsHub } from './execution-events.hub';
import { ExecutionDetail, ExecutionsService } from './executions.service';

const TERMINAL_STATUSES = new Set(['succeeded', 'failed']);
const HEARTBEAT_MS = 15_000;
const COALESCE_MS = 50;
const RECONNECT_HINT_MS = 3_000;
const STREAM_LIMIT_RETRY_AFTER_SECONDS = 10;
const REFRESH_RETRY_BASE_MS = 250;
const REFRESH_ATTEMPTS = 3;
export const STREAM_BUFFER_LIMIT_BYTES = 2 * 1024 * 1024;
export const STREAM_STALL_LIMIT_MS = 60_000;
const WATCH_SECONDS = 120;
const WATCH_RENEW_MS = 60_000;
const WATCH_RETRY_MS = 5_000;
const WATCH_SETTLE_MS = 1_000;

interface Frame {
  text: string;
  final: boolean;
}

interface Subscriber {
  deliver(frame: Frame): void;
  close(): void;
}

interface Feed {
  key: string;
  tenantId: string;
  executionId: string;
  subscribers: Set<Subscriber>;
  unsubscribe: () => void;
  coalesce?: NodeJS.Timeout;
  retry?: NodeJS.Timeout;
  watch?: NodeJS.Timeout;
  refreshing: boolean;
  refreshAgain: boolean;
  failures: number;
}

function snapshotFrame(snapshot: ExecutionDetail): Frame {
  return { text: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`, final: TERMINAL_STATUSES.has(snapshot.status) };
}

const GONE_FRAME: Frame = { text: 'event: gone\ndata: {}\n\n', final: true };

@Injectable()
export class ExecutionStreamService implements BeforeApplicationShutdown {
  private readonly openStreams = new Map<string, number>();
  private readonly activeStreams = new Set<() => void>();
  private readonly feeds = new Map<string, Feed>();
  private stopping = false;

  constructor(
    private readonly hub: ExecutionEventsHub,
    private readonly executions: ExecutionsService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  beforeApplicationShutdown(): void {
    this.stopping = true;
    for (const finish of [...this.activeStreams]) finish();
  }

  private releaseSlot(tenantId: string): void {
    const remaining = (this.openStreams.get(tenantId) ?? 1) - 1;
    if (remaining > 0) this.openStreams.set(tenantId, remaining);
    else this.openStreams.delete(tenantId);
  }

  private join(tenantId: string, executionId: string, subscriber: Subscriber): { feed: Feed; leave: () => void } {
    const key = `${tenantId}:${executionId}`;
    let feed = this.feeds.get(key);
    if (!feed) {
      const created: Feed = {
        key,
        tenantId,
        executionId,
        subscribers: new Set(),
        unsubscribe: () => undefined,
        refreshing: false,
        refreshAgain: false,
        failures: 0,
      };
      created.unsubscribe = this.hub.subscribe(executionId, () => this.scheduleRefresh(created));
      this.feeds.set(key, created);
      this.renewWatch(created, false);
      feed = created;
    }
    const joined = feed;
    joined.subscribers.add(subscriber);
    const leave = () => {
      joined.subscribers.delete(subscriber);
      if (joined.subscribers.size > 0 || this.feeds.get(key) !== joined) return;
      this.feeds.delete(key);
      joined.unsubscribe();
      clearTimeout(joined.coalesce);
      clearTimeout(joined.retry);
      clearTimeout(joined.watch);
    };
    return { feed: joined, leave };
  }

  private renewWatch(feed: Feed, lastRenewalFailed: boolean): void {
    feed.watch = setTimeout(
      async () => {
        const renewed = await this.executions.watch(feed.tenantId, feed.executionId, WATCH_SECONDS).then(
          () => true,
          () => false,
        );
        if (this.feeds.get(feed.key) !== feed) return;
        if (renewed && lastRenewalFailed) this.scheduleRefresh(feed);
        this.renewWatch(feed, !renewed);
      },
      lastRenewalFailed ? WATCH_RETRY_MS : WATCH_RENEW_MS,
    );
  }

  private scheduleRefresh(feed: Feed): void {
    if (feed.coalesce || this.feeds.get(feed.key) !== feed) return;
    feed.coalesce = setTimeout(() => {
      feed.coalesce = undefined;
      void this.refresh(feed);
    }, COALESCE_MS);
  }

  private broadcast(feed: Feed, frame: Frame): void {
    for (const subscriber of [...feed.subscribers]) subscriber.deliver(frame);
  }

  private async refresh(feed: Feed): Promise<void> {
    if (feed.refreshing) {
      feed.refreshAgain = true;
      return;
    }
    feed.refreshing = true;
    try {
      do {
        feed.refreshAgain = false;
        const frame = snapshotFrame(await this.executions.get(feed.tenantId, feed.executionId));
        feed.failures = 0;
        this.broadcast(feed, frame);
      } while (feed.refreshAgain && feed.subscribers.size > 0);
    } catch (error) {
      if (feed.subscribers.size === 0) return;
      if (error instanceof NotFoundException) {
        this.broadcast(feed, GONE_FRAME);
        return;
      }
      feed.failures++;
      if (feed.failures >= REFRESH_ATTEMPTS) {
        feed.failures = 0;
        for (const subscriber of [...feed.subscribers]) subscriber.close();
        return;
      }
      feed.retry = setTimeout(() => {
        feed.retry = undefined;
        void this.refresh(feed);
      }, REFRESH_RETRY_BASE_MS * 2 ** (feed.failures - 1));
    } finally {
      feed.refreshing = false;
    }
  }

  async stream(tenantId: string, executionId: string, req: Request, res: Response): Promise<void> {
    if (this.stopping) throw new ServiceUnavailableException('The server is shutting down');
    const open = this.openStreams.get(tenantId) ?? 0;
    if (open >= this.config.executionStreamsPerTenant) {
      throw new TooManyRequestsException('Too many open execution streams', STREAM_LIMIT_RETRY_AFTER_SECONDS);
    }
    this.openStreams.set(tenantId, open + 1);

    let closed = false;
    let started = false;
    let changedBeforeStart = false;
    let blockedSince: number | undefined;
    let pending: Frame | undefined;
    const timers: { heartbeat?: NodeJS.Timeout; settle?: NodeJS.Timeout } = {};

    const finish = (destroy = false) => {
      if (closed) return;
      closed = true;
      this.activeStreams.delete(finish);
      leave();
      clearInterval(timers.heartbeat);
      clearTimeout(timers.settle);
      res.off('drain', onDrain);
      this.releaseSlot(tenantId);
      if (destroy) res.destroy();
      else if (!res.writableEnded) res.end();
    };

    const write = (frame: Frame) => {
      const flushed = res.write(frame.text);
      if (frame.final) return finish();
      if (flushed) return;
      if (res.writableLength > STREAM_BUFFER_LIMIT_BYTES) return finish(true);
      blockedSince = Date.now();
      res.once('drain', onDrain);
    };

    function onDrain() {
      blockedSince = undefined;
      const next = pending;
      pending = undefined;
      if (next && !closed) write(next);
    }

    const subscriber: Subscriber = {
      deliver: (frame) => {
        if (closed) return;
        if (!started) {
          changedBeforeStart = true;
          return;
        }
        if (blockedSince !== undefined) {
          pending = frame;
          return;
        }
        write(frame);
      },
      close: () => finish(),
    };

    const { feed, leave } = this.join(tenantId, executionId, subscriber);
    req.on('close', () => finish());
    const abandon = (error: Error) => {
      if (closed) return;
      closed = true;
      leave();
      this.releaseSlot(tenantId);
      throw error;
    };
    let first: ExecutionDetail;
    try {
      await this.executions.watch(tenantId, executionId, WATCH_SECONDS);
      first = await this.executions.get(tenantId, executionId);
    } catch (error) {
      return abandon(error as Error);
    }
    if (closed) return;
    if (req.socket.destroyed) return finish();
    if (this.stopping) return abandon(new ServiceUnavailableException('The server is shutting down'));

    this.activeStreams.add(finish);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`retry: ${RECONNECT_HINT_MS}\n\n`);
    timers.heartbeat = setInterval(() => {
      if (blockedSince === undefined) res.write(': keep-alive\n\n');
      else if (Date.now() - blockedSince > STREAM_STALL_LIMIT_MS) finish(true);
    }, HEARTBEAT_MS);
    started = true;
    write(snapshotFrame(first));
    if (changedBeforeStart && !closed) this.scheduleRefresh(feed);
    if (!closed) timers.settle = setTimeout(() => this.scheduleRefresh(feed), WATCH_SETTLE_MS);
  }
}

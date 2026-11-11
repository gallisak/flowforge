import { BeforeApplicationShutdown, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Request, Response } from 'express';
import { API_CONFIG, ApiConfig } from '../config/config';
import { TooManyRequestsException } from '../limits/too-many-requests';
import { ExecutionEventsHub } from './execution-events.hub';
import { ExecutionsService } from './executions.service';

const TERMINAL_STATUSES = new Set(['succeeded', 'failed']);
const HEARTBEAT_MS = 15_000;
const COALESCE_MS = 50;
const RECONNECT_HINT_MS = 3_000;
const STREAM_LIMIT_RETRY_AFTER_SECONDS = 10;

@Injectable()
export class ExecutionStreamService implements BeforeApplicationShutdown {
  private readonly openStreams = new Map<string, number>();
  private readonly activeStreams = new Set<() => void>();
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

  async stream(tenantId: string, executionId: string, req: Request, res: Response): Promise<void> {
    if (this.stopping) throw new ServiceUnavailableException('The server is shutting down');
    const open = this.openStreams.get(tenantId) ?? 0;
    if (open >= this.config.executionStreamsPerTenant) {
      throw new TooManyRequestsException('Too many open execution streams', STREAM_LIMIT_RETRY_AFTER_SECONDS);
    }
    this.openStreams.set(tenantId, open + 1);

    let closed = false;
    let refreshing = false;
    let refreshAgain = false;
    const timers: { coalesce?: NodeJS.Timeout; heartbeat?: NodeJS.Timeout } = {};

    const finish = () => {
      if (closed) return;
      closed = true;
      this.activeStreams.delete(finish);
      unsubscribe();
      clearTimeout(timers.coalesce);
      clearInterval(timers.heartbeat);
      this.releaseSlot(tenantId);
      if (!res.writableEnded) res.end();
    };

    const send = (snapshot: { status: string }) => {
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      if (TERMINAL_STATUSES.has(snapshot.status)) finish();
    };

    const refresh = async () => {
      if (refreshing) {
        refreshAgain = true;
        return;
      }
      refreshing = true;
      try {
        do {
          refreshAgain = false;
          const snapshot = await this.executions.get(tenantId, executionId);
          if (!closed) send(snapshot);
        } while (refreshAgain && !closed);
      } catch (error) {
        if (error instanceof NotFoundException && !closed) {
          res.write('event: gone\ndata: {}\n\n');
          finish();
        }
      } finally {
        refreshing = false;
      }
    };

    const scheduleRefresh = () => {
      if (closed || timers.coalesce) return;
      timers.coalesce = setTimeout(() => {
        timers.coalesce = undefined;
        void refresh();
      }, COALESCE_MS);
    };

    const unsubscribe = this.hub.subscribe(executionId, scheduleRefresh);
    req.on('close', finish);
    const abandon = (error: Error) => {
      if (closed) return;
      closed = true;
      unsubscribe();
      this.releaseSlot(tenantId);
      throw error;
    };
    let first: Awaited<ReturnType<ExecutionsService['get']>>;
    try {
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
    timers.heartbeat = setInterval(() => res.write(': keep-alive\n\n'), HEARTBEAT_MS);
    send(first);
  }
}

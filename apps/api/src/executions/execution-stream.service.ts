import { Inject, Injectable, NotFoundException } from '@nestjs/common';
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
export class ExecutionStreamService {
  private readonly openStreams = new Map<string, number>();

  constructor(
    private readonly hub: ExecutionEventsHub,
    private readonly executions: ExecutionsService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  async stream(tenantId: string, executionId: string, req: Request, res: Response): Promise<void> {
    const open = this.openStreams.get(tenantId) ?? 0;
    if (open >= this.config.executionStreamsPerTenant) {
      throw new TooManyRequestsException('Too many open execution streams', STREAM_LIMIT_RETRY_AFTER_SECONDS);
    }

    let closed = false;
    let refreshing = false;
    let refreshAgain = false;
    const timers: { coalesce?: NodeJS.Timeout; heartbeat?: NodeJS.Timeout } = {};

    const finish = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      clearTimeout(timers.coalesce);
      clearInterval(timers.heartbeat);
      const remaining = (this.openStreams.get(tenantId) ?? 1) - 1;
      if (remaining > 0) this.openStreams.set(tenantId, remaining);
      else this.openStreams.delete(tenantId);
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
    let first: Awaited<ReturnType<ExecutionsService['get']>>;
    try {
      first = await this.executions.get(tenantId, executionId);
    } catch (error) {
      unsubscribe();
      throw error;
    }

    this.openStreams.set(tenantId, (this.openStreams.get(tenantId) ?? 0) + 1);
    req.on('close', finish);
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

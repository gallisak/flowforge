import { Injectable, Logger } from '@nestjs/common';
import { StepDefinition } from '../entities';
import { renderTemplate, StepContext } from './template';

export class StepError extends Error {
  constructor(message: string, readonly retryable = true) {
    super(message);
  }
}

const RETRYABLE_CLIENT_STATUSES = new Set([408, 425, 429]);

export function isRetryableStatus(status: number): boolean {
  return status >= 500 || RETRYABLE_CLIENT_STATUSES.has(status);
}

export interface StepRuntime {
  signal?: AbortSignal;
  idempotencyKey?: string;
}

export function stepIdempotencyKey(executionId: string, stepId: string): string {
  return `${executionId}:${stepId}`;
}

const IDEMPOTENCY_HEADER = 'Idempotency-Key';

@Injectable()
export class StepExecutor {
  private readonly logger = new Logger(StepExecutor.name);

  async execute(step: StepDefinition, ctx: StepContext, runtime: StepRuntime = {}): Promise<unknown> {
    switch (step.type) {
      case 'log':
        this.logger.log(renderTemplate(step.message, ctx));
        return { logged: true };
      case 'delay':
        throw new StepError('delay steps are durable timers scheduled by the job runner', false);
      case 'transform':
        return this.transform(step.expr, ctx);
      case 'http':
        return this.http(step, ctx, runtime);
    }
  }

  private transform(expr: string, ctx: StepContext): unknown {
    try {
      const fn = new Function('ctx', `return (${expr});`);
      return fn(ctx);
    } catch (err) {
      throw new StepError(`transform: ${(err as Error).message}`, false);
    }
  }

  private async http(step: Extract<StepDefinition, { type: 'http' }>, ctx: StepContext, runtime: StepRuntime): Promise<unknown> {
    const { signal, idempotencyKey } = runtime;
    const headers = Object.fromEntries(
      Object.entries(step.headers ?? {}).filter(([name]) => name.toLowerCase() !== IDEMPOTENCY_HEADER.toLowerCase()),
    );
    if (idempotencyKey) headers[IDEMPOTENCY_HEADER] = idempotencyKey;
    const url = renderTemplate(step.url, ctx);
    let res: Response;
    let text: string;
    try {
      res = await fetch(url, {
        method: step.method ?? 'GET',
        headers,
        body: step.body !== undefined ? renderTemplate(step.body, ctx) : undefined,
        signal: signal ? AbortSignal.any([AbortSignal.timeout(15_000), signal]) : AbortSignal.timeout(15_000),
      });
      text = await res.text();
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      const timedOut = (err as Error).name === 'TimeoutError';
      throw new StepError(timedOut ? 'http request timed out' : 'http request failed: connection error', true);
    }
    if (!res.ok) {
      throw new StepError(`http ${res.status}`, isRetryableStatus(res.status));
    }
    try {
      return { status: res.status, body: JSON.parse(text) };
    } catch {
      return { status: res.status, body: text.slice(0, 10_000) };
    }
  }
}

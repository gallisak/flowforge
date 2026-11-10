import { Injectable, Logger } from '@nestjs/common';
import { StepDefinition } from '../entities';
import { renderTemplate, StepContext } from './template';

export class StepError extends Error {
  constructor(message: string, readonly retryable = true) {
    super(message);
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

@Injectable()
export class StepExecutor {
  private readonly logger = new Logger(StepExecutor.name);

  async execute(step: StepDefinition, ctx: StepContext, signal?: AbortSignal): Promise<unknown> {
    switch (step.type) {
      case 'log':
        this.logger.log(renderTemplate(step.message, ctx));
        return { logged: true };
      case 'delay':
        await abortableDelay(step.ms, signal);
        return { waitedMs: step.ms };
      case 'transform':
        return this.transform(step.expr, ctx);
      case 'http':
        return this.http(step, ctx, signal);
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

  private async http(step: Extract<StepDefinition, { type: 'http' }>, ctx: StepContext, signal?: AbortSignal): Promise<unknown> {
    const url = renderTemplate(step.url, ctx);
    const res = await fetch(url, {
      method: step.method ?? 'GET',
      headers: step.headers,
      body: step.body !== undefined ? renderTemplate(step.body, ctx) : undefined,
      signal: signal ? AbortSignal.any([AbortSignal.timeout(15_000), signal]) : AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new StepError(`http ${res.status}`, res.status >= 500);
    }
    try {
      return { status: res.status, body: JSON.parse(text) };
    } catch {
      return { status: res.status, body: text.slice(0, 10_000) };
    }
  }
}

import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { MAX_JSON_DEPTH, valueExceedsDepth } from '../common/json-depth';
import { toStorable } from '../common/storable';
import { WORKER_CONFIG, WorkerConfig } from '../config/config';
import { StepDefinition } from '../entities';
import {
  findDestinationError,
  InvalidRequestUrlError,
  ResponseTooLargeError,
  SafeHttpClient,
  SafeHttpResponse,
  TooManyRedirectsError,
} from './http/safe-http';
import { SANDBOX_STACK_BYTES, TransformError, TransformSandbox } from './sandbox/transform-sandbox';
import { renderTemplate, renderUrlTemplate, StepContext, UrlTemplateError } from './template';

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
export const LOG_MESSAGE_MAX_LENGTH = 2_048;

export function sanitizeLogMessage(message: string): string {
  const singleLine = message.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  return singleLine.length > LOG_MESSAGE_MAX_LENGTH ? `${singleLine.slice(0, LOG_MESSAGE_MAX_LENGTH)}...` : singleLine;
}

const MAX_SANDBOX_THREADS = 4;
const REJECTED_REQUEST_CODES = new Set(['UND_ERR_INVALID_ARG', 'UND_ERR_NOT_SUPPORTED']);

@Injectable()
export class StepExecutor implements OnApplicationShutdown {
  private readonly logger = new Logger(StepExecutor.name);
  private readonly sandbox: TransformSandbox;
  private readonly httpClient: SafeHttpClient;
  private readonly outputMaxBytes: number;

  constructor(@Inject(WORKER_CONFIG) config: WorkerConfig) {
    this.httpClient = new SafeHttpClient({
      allowlist: config.ssrfAllowlist,
      timeoutMs: config.httpTimeoutMs,
      maxRedirects: config.httpMaxRedirects,
      maxResponseBytes: config.httpMaxResponseBytes,
    });
    this.outputMaxBytes = config.stepOutputMaxBytes;
    this.sandbox = new TransformSandbox(
      {
        timeoutMs: config.transformTimeoutMs,
        memoryBytes: config.transformMemoryMb * 1024 * 1024,
        stackBytes: SANDBOX_STACK_BYTES,
      },
      Math.min(config.workerConcurrency, MAX_SANDBOX_THREADS),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.sandbox.close(), this.httpClient.close()]);
  }

  async execute(step: StepDefinition, ctx: StepContext, runtime: StepRuntime = {}): Promise<unknown> {
    const result = await this.run(step, ctx, runtime);
    if (valueExceedsDepth(result, MAX_JSON_DEPTH)) {
      throw new StepError(`step output is nested deeper than ${MAX_JSON_DEPTH} levels`, false);
    }
    const output = toStorable(result);
    const size = output === undefined ? 0 : Buffer.byteLength(JSON.stringify(output));
    if (size > this.outputMaxBytes) throw new StepError(`step output exceeds ${this.outputMaxBytes} bytes`, false);
    return output;
  }

  private async run(step: StepDefinition, ctx: StepContext, runtime: StepRuntime): Promise<unknown> {
    switch (step.type) {
      case 'log':
        this.logger.log(sanitizeLogMessage(renderTemplate(step.message, ctx)));
        return { logged: true };
      case 'delay':
        throw new StepError('delay steps are durable timers scheduled by the job runner', false);
      case 'transform':
        return this.transform(step.expr, ctx);
      case 'http':
        return this.http(step, ctx, runtime);
    }
  }

  private async transform(expr: string, ctx: StepContext): Promise<unknown> {
    try {
      return await this.sandbox.evaluate(expr, ctx);
    } catch (err) {
      if (err instanceof TransformError) throw new StepError(err.message, err.retryable);
      throw err;
    }
  }

  private async http(step: Extract<StepDefinition, { type: 'http' }>, ctx: StepContext, runtime: StepRuntime): Promise<unknown> {
    const { signal, idempotencyKey } = runtime;
    const headers = Object.fromEntries(
      Object.entries(step.headers ?? {}).filter(([name]) => name.toLowerCase() !== IDEMPOTENCY_HEADER.toLowerCase()),
    );
    if (idempotencyKey) headers[IDEMPOTENCY_HEADER] = idempotencyKey;
    let res: SafeHttpResponse;
    try {
      res = await this.httpClient.request(renderUrlTemplate(step.url, ctx), {
        method: step.method ?? 'GET',
        headers,
        body: step.body !== undefined ? renderTemplate(step.body, ctx) : undefined,
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      throw this.httpFailure(err);
    }
    if (res.status < 200 || res.status > 299) {
      throw new StepError(`http ${res.status}`, isRetryableStatus(res.status));
    }
    try {
      return { status: res.status, body: JSON.parse(res.body) };
    } catch {
      return { status: res.status, body: res.body.slice(0, 10_000) };
    }
  }

  private httpFailure(err: unknown): StepError {
    const blocked = findDestinationError(err);
    if (blocked) return new StepError(blocked.message, false);
    const permanent = [InvalidRequestUrlError, UrlTemplateError, TooManyRedirectsError, ResponseTooLargeError];
    if (permanent.some((type) => err instanceof type)) return new StepError((err as Error).message, false);
    if (REJECTED_REQUEST_CODES.has((err as { code?: string }).code ?? '')) return new StepError('http request is invalid', false);
    const name = (err as Error).name;
    const timedOut = name === 'TimeoutError' || name === 'HeadersTimeoutError' || name === 'BodyTimeoutError';
    return new StepError(timedOut ? 'http request timed out' : 'http request failed: connection error', true);
  }
}

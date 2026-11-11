import { AsyncLocalStorage } from 'async_hooks';

export interface LogContext {
  correlationId?: string;
  tenantId?: string;
  executionId?: string;
  jobId?: string;
  attempt?: number;
  stepId?: string;
  eventId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export function runWithLogContext<T>(context: LogContext, work: () => T): T {
  return storage.run(context, work);
}

export function currentLogContext(): LogContext | undefined {
  return storage.getStore();
}

export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

import { WorkerConfig } from '../src/config/config';
import { TenantDb } from '../src/db/tenant-db.service';
import { Job } from '../src/entities';
import { FailOutcome, JobQueueService } from '../src/engine/job-queue.service';
import { JobRunnerService } from '../src/engine/job-runner.service';
import { StepExecutor } from '../src/engine/step-executor';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function jobWith(attempts: number): Job {
  return { id: 'job-1', tenantId: 'tenant-1', executionId: 'execution-1', attempts, attemptsAtProgress: 0, maxAttempts: 8, runAt: new Date() } as Job;
}

function fakeDb(): TenantDb {
  const em = {
    findOne: async (entity: { name: string }) =>
      entity.name === 'Execution'
        ? { id: 'execution-1', workflowId: 'workflow-1', workflowVersion: 1, input: {}, correlationId: null }
        : { steps: [{ id: 'only', type: 'log', message: 'hi' }] },
    exists: async () => true,
    find: async () => [],
    query: async () => [{ bytes: '0' }],
  };
  return { run: async (_tenant: string, work: (manager: unknown) => Promise<unknown>) => work(em) } as unknown as TenantDb;
}

function runnerWith(queue: Partial<JobQueueService>, execute: (signal: AbortSignal) => Promise<void>) {
  const fullQueue = {
    markRunning: async () => undefined,
    startStep: async () => 'step-run-1',
    finishStep: async () => ({}),
    complete: async () => true,
    extendLease: async () => true,
    fail: async () => 'retry',
    ...queue,
  } as unknown as JobQueueService;
  const executor = {
    execute: async (_step: unknown, _ctx: unknown, runtime: { signal: AbortSignal }) => {
      await execute(runtime.signal);
      return { output: {}, bytes: 2 };
    },
  } as unknown as StepExecutor;
  const config = { leaseSeconds: 0.3, retryBaseMs: 10, retryCapMs: 20, executionOutputMaxBytes: 1_000 } as WorkerConfig;
  const runner = new JobRunnerService(fullQueue, executor, fakeDb(), config);
  return runner as unknown as { processWithLease(job: Job, claimStartedAt: number): Promise<void> };
}

describe('job runner leases', () => {
  it('keeps renewing a newer claim of the same job after an older run of it finishes', async () => {
    const renewedAttempts: number[] = [];
    const older = deferred();
    const newer = deferred();
    const signals: AbortSignal[] = [];
    const runner = runnerWith(
      {
        extendLease: async (job: Job) => {
          renewedAttempts.push(job.attempts);
          return true;
        },
      },
      async (signal) => {
        signals.push(signal);
        await (signals.length === 1 ? older.promise : newer.promise);
      },
    );

    const olderRun = runner.processWithLease(jobWith(1), Date.now());
    await wait(20);
    const newerRun = runner.processWithLease(jobWith(2), Date.now());
    await wait(20);
    older.resolve();
    await olderRun;
    const renewalsBefore = renewedAttempts.filter((attempt) => attempt === 2).length;
    await wait(450);

    expect(signals[1].aborted).toBe(false);
    expect(renewedAttempts.filter((attempt) => attempt === 2).length).toBeGreaterThan(renewalsBefore);
    newer.resolve();
    await newerRun;
  });

  it('returns the job to the queue when it cannot renew the lease in time', async () => {
    const fail = jest.fn(async (): Promise<FailOutcome> => 'retry');
    const runner = runnerWith(
      {
        extendLease: async () => {
          throw new Error('database is unavailable');
        },
        fail,
      },
      (signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    );

    await runner.processWithLease(jobWith(1), Date.now());

    expect(fail).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-1' }), expect.any(String), expect.any(String), true, expect.any(Object));
  });

  it('does not abort a finished job when a renewal answers after it finished', async () => {
    let captured: AbortSignal | undefined;
    const runner = runnerWith(
      {
        extendLease: async () => {
          await wait(150);
          return true;
        },
      },
      async (signal) => {
        captured = signal;
        await wait(120);
      },
    );

    await runner.processWithLease(jobWith(1), Date.now());
    await wait(500);

    expect(captured?.aborted).toBe(false);
  });
});

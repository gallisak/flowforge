import { ConfigError, loadSchedulerConfig, loadWorkerConfig } from '../src/config/config';

const base = { DATABASE_URL: 'postgres://flowforge_app:secret-password@localhost:5432/flowforge' };

function problemsOf(load: () => unknown): string[] {
  try {
    load();
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

describe('configuration cross-checks', () => {
  it('sizes the worker pool for its slots, heartbeats and notification deliveries by default', () => {
    expect(loadWorkerConfig({ ...base, WORKER_CONCURRENCY: '4', OUTBOX_CONCURRENCY: '10' }).databasePoolSize).toBe(20);
    expect(loadWorkerConfig({ ...base, WORKER_CONCURRENCY: '32', OUTBOX_CONCURRENCY: '5' }).databasePoolSize).toBe(71);
  });

  it('refuses a worker pool smaller than what its slots need at the same time', () => {
    expect(problemsOf(() => loadWorkerConfig({ ...base, WORKER_CONCURRENCY: '32', DB_POOL_SIZE: '10' }))).toEqual([
      'DB_POOL_SIZE must be at least 76 for WORKER_CONCURRENCY=32 and OUTBOX_CONCURRENCY=10',
    ]);
  });

  it('refuses a total output limit below the limit of one step', () => {
    expect(problemsOf(() => loadWorkerConfig({ ...base, STEP_OUTPUT_MAX_BYTES: '2048', EXECUTION_OUTPUT_MAX_BYTES: '1024' }))).toEqual([
      'EXECUTION_OUTPUT_MAX_BYTES must not be smaller than STEP_OUTPUT_MAX_BYTES',
    ]);
  });

  it('refuses a scheduler tick or postponement that is not shorter than the misfire grace window', () => {
    expect(problemsOf(() => loadSchedulerConfig({ ...base, SCHEDULER_TICK_MS: '60000', SCHEDULER_MISFIRE_GRACE_MS: '60000' }))).toEqual([
      'SCHEDULER_TICK_MS must be shorter than SCHEDULER_MISFIRE_GRACE_MS',
    ]);
    expect(problemsOf(() => loadSchedulerConfig({ ...base, SCHEDULER_POSTPONE_MS: '90000', SCHEDULER_MISFIRE_GRACE_MS: '60000' }))).toEqual([
      'SCHEDULER_POSTPONE_MS must be shorter than SCHEDULER_MISFIRE_GRACE_MS',
    ]);
  });
});

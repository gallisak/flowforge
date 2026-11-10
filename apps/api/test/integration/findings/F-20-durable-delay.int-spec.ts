import { Execution, Job, StepRun } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { Receiver, startReceiver } from '../../support/receiver';
import { InProcessWorkers, spawnWorkerProcess, startInProcessWorkers, WorkerProcess } from '../../support/worker';

const DELAY_MS = 3_000;

describe('F-20 a delay step is a durable timer', () => {
  const ctx = useIntegrationContext();
  let receiver: Receiver;
  let workers: InProcessWorkers | undefined;
  let spawned: WorkerProcess | undefined;
  const saved = { lease: process.env.WORKER_LEASE_SECONDS, reaper: process.env.WORKER_REAPER_INTERVAL_MS };

  async function enqueue(name: string, steps: Parameters<typeof seedWorkflow>[2]): Promise<{ execution: Execution; job: Job }> {
    const { tenant } = await seedTenant(ctx.ds, name);
    const workflow = await seedWorkflow(ctx.ds, tenant.id, steps);
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.id, workflowId: workflow.id, input: {} });
    const job = await ctx.ds.getRepository(Job).save({ tenantId: tenant.id, executionId: execution.id });
    return { execution, job };
  }

  const statusOf = async (executionId: string) => (await ctx.ds.getRepository(Execution).findOneByOrFail({ id: executionId })).status;

  beforeAll(async () => {
    process.env.WORKER_LEASE_SECONDS = '2';
    process.env.WORKER_REAPER_INTERVAL_MS = '200';
    receiver = await startReceiver();
  });

  afterEach(async () => {
    await spawned?.kill('SIGKILL');
    spawned = undefined;
    await workers?.stop();
    workers = undefined;
  });

  afterAll(async () => {
    await receiver?.close();
    for (const [name, value] of [
      ['WORKER_LEASE_SECONDS', saved.lease],
      ['WORKER_REAPER_INTERVAL_MS', saved.reaper],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('does not occupy a worker slot while it waits', async () => {
    const sleeper = await enqueue('sleeper', [
      { id: 'nap', type: 'delay', ms: DELAY_MS },
      { id: 'awake', type: 'log', message: 'awake' },
    ]);
    workers = await startInProcessWorkers(1, 1);
    await eventually(async () => expect(await ctx.ds.getRepository(StepRun).countBy({ executionId: sleeper.execution.id })).toBe(1));

    const quick = await enqueue('quick', [{ id: 'hello', type: 'log', message: 'hi' }]);

    await eventually(async () => expect(await statusOf(quick.execution.id)).toBe('succeeded'), { timeoutMs: 1_500 });
    expect(await statusOf(sleeper.execution.id)).not.toBe('succeeded');
    await eventually(async () => expect(await statusOf(sleeper.execution.id)).toBe('succeeded'), { timeoutMs: 10_000 });
  });

  it('releases the job and persists the wake-up time while it waits', async () => {
    const { execution, job } = await enqueue('persisted-timer', [
      { id: 'nap', type: 'delay', ms: DELAY_MS },
      { id: 'awake', type: 'log', message: 'awake' },
    ]);
    workers = await startInProcessWorkers(1);

    await eventually(async () =>
      expect(await ctx.ds.getRepository(StepRun).findOneByOrFail({ executionId: execution.id, stepIndex: 0 })).toMatchObject({
        status: 'waiting',
      }),
    );
    const stored = await ctx.ds.getRepository(Job).findOneByOrFail({ id: job.id });
    expect(stored).toMatchObject({ status: 'queued', lockedBy: null });
    expect(stored.runAt.getTime()).toBeGreaterThan(Date.now() + 1_000);
    expect(await statusOf(execution.id)).toBe('waiting');
  });

  it('survives a worker crash without restarting the timer or repeating earlier steps', async () => {
    const { execution } = await enqueue('crash-during-delay', [
      { id: 'before', type: 'http', url: `${receiver.url}/before`, method: 'POST' },
      { id: 'nap', type: 'delay', ms: DELAY_MS },
      { id: 'after', type: 'http', url: `${receiver.url}/after`, method: 'POST' },
    ]);
    spawned = spawnWorkerProcess({
      DATABASE_URL: ctx.db.url,
      WORKER_CONCURRENCY: '1',
      WORKER_LEASE_SECONDS: '2',
      WORKER_REAPER_INTERVAL_MS: '200',
    });
    await eventually(() => expect(receiver.requests.some((r) => r.path === '/before')).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await spawned.kill('SIGKILL');
    spawned = undefined;

    workers = await startInProcessWorkers(1);
    await eventually(async () => expect(await statusOf(execution.id)).toBe('succeeded'), { timeoutMs: 15_000 });

    const before = receiver.requests.filter((r) => r.path === '/before');
    const after = receiver.requests.filter((r) => r.path === '/after');
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
    const waited = after[0].receivedAt - before[0].receivedAt;
    expect(waited).toBeGreaterThanOrEqual(DELAY_MS - 100);
    expect(waited).toBeLessThan(DELAY_MS + 1_500);
  });
});

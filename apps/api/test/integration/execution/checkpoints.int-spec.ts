import { Execution, Job, StepRun } from '../../../src/entities';
import { JobRunnerService } from '../../../src/engine/job-runner.service';
import { useIntegrationContext } from '../../support/context';
import { settledCalls } from '../../support/spies';
import { seedTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { Receiver, startReceiver } from '../../support/receiver';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

describe('step checkpoints', () => {
  const ctx = useIntegrationContext();
  let receiver: Receiver;
  let workers: InProcessWorkers | undefined;
  const failuresLeft = new Map<string, number>();
  const saved = {
    base: process.env.RETRY_BASE_MS,
    cap: process.env.RETRY_CAP_MS,
    lease: process.env.WORKER_LEASE_SECONDS,
    statement: process.env.DB_STATEMENT_TIMEOUT_MS,
  };

  async function enqueue(steps: Parameters<typeof seedWorkflow>[2]): Promise<{ execution: Execution; job: Job }> {
    const { tenant } = await seedTenant(ctx.ds, `checkpoints-${failuresLeft.size}-${Date.now()}`);
    const workflow = await seedWorkflow(ctx.ds, tenant.id, steps);
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.id, workflowId: workflow.id, input: {} });
    const job = await ctx.ds.getRepository(Job).save({ tenantId: tenant.id, executionId: execution.id, maxAttempts: 5 });
    return { execution, job };
  }

  beforeAll(async () => {
    process.env.RETRY_BASE_MS = '50';
    process.env.RETRY_CAP_MS = '100';
    process.env.WORKER_LEASE_SECONDS = '2';
    process.env.DB_STATEMENT_TIMEOUT_MS = '1500';
    receiver = await startReceiver((req, res) => {
      if (req.path === '/slow') {
        setTimeout(() => res.writeHead(200).end('{}'), 4_000);
        return;
      }
      const left = failuresLeft.get(req.path) ?? 0;
      failuresLeft.set(req.path, left - 1);
      res.writeHead(left > 0 ? 503 : 200, { 'content-type': 'application/json' }).end('{}');
    });
  });

  afterEach(async () => {
    await workers?.stop();
    workers = undefined;
  });

  afterAll(async () => {
    await receiver?.close();
    for (const [name, value] of [
      ['RETRY_BASE_MS', saved.base],
      ['RETRY_CAP_MS', saved.cap],
      ['WORKER_LEASE_SECONDS', saved.lease],
      ['DB_STATEMENT_TIMEOUT_MS', saved.statement],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('counts the attempts of each step separately', async () => {
    failuresLeft.set('/third-time-lucky', 2);
    const { execution } = await enqueue([
      { id: 'first', type: 'log', message: 'once' },
      { id: 'second', type: 'http', url: `${receiver.url}/third-time-lucky` },
    ]);

    workers = await startInProcessWorkers(1);
    await eventually(async () =>
      expect(await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id })).toMatchObject({ status: 'succeeded' }),
    );

    const runs = await ctx.ds.getRepository(StepRun).find({ where: { executionId: execution.id }, order: { stepIndex: 'ASC' } });
    expect(runs.map((r) => [r.stepId, r.attempts, r.status])).toEqual([
      ['first', 1, 'succeeded'],
      ['second', 3, 'succeeded'],
    ]);
    expect(runs.every((r) => r.finishedAt !== null)).toBe(true);
  });

  it('shows the execution as pending, with the last error, while it waits for a retry', async () => {
    failuresLeft.set('/fails-forever', 1_000);
    const { execution } = await enqueue([{ id: 'call', type: 'http', url: `${receiver.url}/fails-forever` }]);
    process.env.RETRY_BASE_MS = '5000';
    process.env.RETRY_CAP_MS = '5000';
    try {
      workers = await startInProcessWorkers(1);
      await eventually(async () =>
        expect(await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id })).toMatchObject({
          status: 'pending',
          error: 'http 503',
        }),
      );
    } finally {
      process.env.RETRY_BASE_MS = '50';
      process.env.RETRY_CAP_MS = '100';
    }
  });

  it('does not let a worker that lost the job write a checkpoint', async () => {
    const { execution, job } = await enqueue([{ id: 'slow', type: 'http', url: `${receiver.url}/slow` }]);
    const processed = jest.spyOn(JobRunnerService.prototype, 'process');
    ctx.onTeardown(() => processed.mockRestore());

    workers = await startInProcessWorkers(1);
    await eventually(() => expect(receiver.requests.some((r) => r.path === '/slow')).toBe(true));
    await ctx.ds.getRepository(Job).update(job.id, { lockedBy: 'new-owner', lockedUntil: new Date(Date.now() + 3_600_000) });
    await settledCalls(processed);

    const [run] = await ctx.ds.getRepository(StepRun).findBy({ executionId: execution.id });
    expect(run).toMatchObject({ status: 'running', output: null, error: null });
  });
});

import { Execution, Job } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

describe('F-04 jobs held by a worker that disappeared are recovered', () => {
  const ctx = useIntegrationContext();
  let workers: InProcessWorkers | undefined;
  const previousReaperInterval = process.env.WORKER_REAPER_INTERVAL_MS;

  async function seedAbandonedJob(attempts: number): Promise<{ execution: Execution; job: Job }> {
    const { tenant } = await seedTenant(ctx.ds, `abandoned-${attempts}`);
    const workflow = await seedWorkflow(ctx.ds, tenant.id, [{ id: 'hello', type: 'log', message: 'hi' }]);
    const execution = await ctx.ds
      .getRepository(Execution)
      .save({ tenantId: tenant.id, workflowId: workflow.id, status: 'running', input: {} });
    const job = await ctx.ds.getRepository(Job).save({
      tenantId: tenant.id,
      executionId: execution.id,
      status: 'running',
      attempts,
      maxAttempts: 3,
      lockedBy: 'worker-that-died',
      lockedUntil: new Date(Date.now() - 60_000),
    });
    return { execution, job };
  }

  beforeAll(() => {
    process.env.WORKER_REAPER_INTERVAL_MS = '200';
  });

  afterEach(async () => {
    await workers?.stop();
    workers = undefined;
  });

  afterAll(() => {
    if (previousReaperInterval === undefined) delete process.env.WORKER_REAPER_INTERVAL_MS;
    else process.env.WORKER_REAPER_INTERVAL_MS = previousReaperInterval;
  });

  it('returns an expired job to the queue so another worker completes it', async () => {
    const { execution, job } = await seedAbandonedJob(1);

    workers = await startInProcessWorkers(1);

    await eventually(async () => {
      expect(await ctx.ds.getRepository(Job).findOneByOrFail({ id: job.id })).toMatchObject({ status: 'done', attempts: 2 });
      expect(await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id })).toMatchObject({ status: 'succeeded' });
    });
  });

  it('stops retrying a job whose worker keeps disappearing and marks it dead', async () => {
    const { execution, job } = await seedAbandonedJob(3);

    workers = await startInProcessWorkers(1);

    await eventually(async () => {
      expect(await ctx.ds.getRepository(Job).findOneByOrFail({ id: job.id })).toMatchObject({ status: 'dead', lockedBy: null });
      expect(await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id })).toMatchObject({
        status: 'failed',
        error: expect.stringMatching(/lease/i),
      });
    });
  });
});

import { DataSource } from 'typeorm';
import { TenantDb } from '../../../src/db/tenant-db.service';
import { JobQueueService, LeaseLostError } from '../../../src/engine/job-queue.service';
import { Execution, Job, StepRun } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { openDataSource, seedTenant, seedWorkflow } from '../../support/db';

const POLICY = { baseMs: 1_000, capMs: 1_000 };
const STALE_WORKER = 'worker-stale';

type Write = (queue: JobQueueService, job: Job, stepRunId: string) => Promise<unknown>;

const WRITES: Array<[string, Write, unknown]> = [
  ['extendLease', (q, job) => q.extendLease(job, STALE_WORKER, 30), false],
  ['complete', (q, job) => q.complete(job, STALE_WORKER, { status: 'succeeded', output: {} }), false],
  ['fail with a retry', (q, job) => q.fail(job, STALE_WORKER, 'boom', true, POLICY), 'lost'],
  ['fail for good', (q, job) => q.fail(job, STALE_WORKER, 'boom', false, POLICY), 'lost'],
  ['release', (q, job) => q.release(job, STALE_WORKER), false],
  ['markRunning', (q, job) => q.markRunning(job, STALE_WORKER), LeaseLostError],
  ['startStep', (q, job) => q.startStep(job, STALE_WORKER, 1, 'second', null), LeaseLostError],
  ['finishStep', (q, job, stepRunId) => q.finishStep(job, STALE_WORKER, stepRunId, { stale: true }), LeaseLostError],
  ['sleep', (q, job) => q.sleep(job, STALE_WORKER, 1, 'second', 60_000), LeaseLostError],
  ['wakeUp', (q, job) => q.wakeUp(job, STALE_WORKER, 0, { stale: true }), LeaseLostError],
];

describe('writes of a worker whose claim is no longer current', () => {
  const ctx = useIntegrationContext();
  let appDs: DataSource;
  let queue: JobQueueService;

  beforeAll(async () => {
    appDs = await openDataSource(ctx.db.url);
    queue = new JobQueueService(new TenantDb(appDs));
  });

  afterAll(async () => {
    await appDs?.destroy();
  });

  async function claimedJob(name: string): Promise<{ job: Job; stepRunId: string }> {
    const { tenant } = await seedTenant(ctx.ds, name);
    const workflow = await seedWorkflow(ctx.ds, tenant.id, [
      { id: 'first', type: 'log', message: 'x' },
      { id: 'second', type: 'log', message: 'y' },
    ]);
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.id, workflowId: workflow.id, input: {}, status: 'running' });
    const job = await ctx.ds.getRepository(Job).save({
      tenantId: tenant.id,
      executionId: execution.id,
      status: 'running',
      attempts: 1,
      lockedBy: STALE_WORKER,
      lockedUntil: new Date(Date.now() + 60_000),
    });
    const run = await ctx.ds.getRepository(StepRun).save({
      tenantId: tenant.id,
      executionId: execution.id,
      stepIndex: 0,
      stepId: 'first',
      status: 'running',
      attempts: 1,
    });
    return { job, stepRunId: run.id };
  }

  async function stateOf(job: Job): Promise<unknown> {
    return {
      job: await ctx.ds.getRepository(Job).findOneByOrFail({ id: job.id }),
      execution: await ctx.ds.getRepository(Execution).findOneByOrFail({ id: job.executionId }),
      steps: await ctx.ds.getRepository(StepRun).find({ where: { executionId: job.executionId }, order: { stepIndex: 'ASC' } }),
    };
  }

  async function expectRefused(write: Write, job: Job, stepRunId: string, refusal: unknown): Promise<void> {
    const before = await stateOf(job);
    if (refusal === LeaseLostError) await expect(write(queue, job, stepRunId)).rejects.toBeInstanceOf(LeaseLostError);
    else expect(await write(queue, job, stepRunId)).toBe(refusal);
    expect(await stateOf(job)).toEqual(before);
  }

  it.each(WRITES)('refuses %s after another worker took the job over', async (_name, write, refusal) => {
    const { job, stepRunId } = await claimedJob(`fenced-owner-${_name}`);
    await ctx.ds.getRepository(Job).update(job.id, { lockedBy: 'worker-new', attempts: 2 });

    await expectRefused(write, job, stepRunId, refusal);
  });

  it.each(WRITES)('refuses %s after the same worker claimed the job again', async (_name, write, refusal) => {
    const { job, stepRunId } = await claimedJob(`fenced-attempt-${_name}`);
    await ctx.ds.getRepository(Job).update(job.id, { attempts: 2 });

    await expectRefused(write, job, stepRunId, refusal);
  });

  it.each(WRITES)('lets the current owner %s', async (_name, write, refusal) => {
    const { job, stepRunId } = await claimedJob(`owner-${_name}`);
    if (_name === 'wakeUp') {
      await ctx.ds.getRepository(StepRun).update(stepRunId, { status: 'waiting', wakeAt: new Date(Date.now() - 1_000) });
    }

    if (refusal === LeaseLostError) await expect(write(queue, job, stepRunId)).resolves.not.toThrow();
    else expect(await write(queue, job, stepRunId)).not.toBe(refusal);
  });
});

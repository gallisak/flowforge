import { Execution, Job, StepRun, Workflow } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

describe('durable timers', () => {
  const ctx = useIntegrationContext();
  let workers: InProcessWorkers | undefined;

  async function enqueue(name: string, ms: number): Promise<{ execution: Execution; job: Job }> {
    const { tenant } = await seedTenant(ctx.ds, name);
    const workflow = await seedWorkflow(ctx.ds, tenant.id, [
      { id: 'nap', type: 'delay', ms },
      { id: 'awake', type: 'log', message: 'awake' },
    ]);
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.id, workflowId: workflow.id, input: {} });
    const job = await ctx.ds.getRepository(Job).save({ tenantId: tenant.id, executionId: execution.id });
    return { execution, job };
  }

  afterEach(async () => {
    await workers?.stop();
    workers = undefined;
  });

  it('goes back to sleep until the stored wake-up time when picked up too early', async () => {
    const { execution, job } = await enqueue('woken-early', 60_000);
    workers = await startInProcessWorkers(1);
    await eventually(async () =>
      expect(await ctx.ds.getRepository(StepRun).findOneByOrFail({ executionId: execution.id })).toMatchObject({ status: 'waiting' }),
    );
    const { wakeAt } = await ctx.ds.getRepository(StepRun).findOneByOrFail({ executionId: execution.id });

    await ctx.ds.getRepository(Job).update(job.id, { runAt: new Date(Date.now() - 1_000) });

    await eventually(async () => {
      const parked = await ctx.ds.getRepository(Job).findOneByOrFail({ id: job.id });
      expect(parked).toMatchObject({ status: 'queued', attempts: 0 });
      expect(parked.runAt.getTime()).toBe(wakeAt?.getTime());
    });
    expect(await ctx.ds.getRepository(StepRun).findOneByOrFail({ executionId: execution.id })).toMatchObject({
      status: 'waiting',
      attempts: 1,
    });
  });

  it('fails a sleeping step together with its execution when the workflow is deleted meanwhile', async () => {
    const { execution, job } = await enqueue('deleted-while-sleeping', 60_000);
    workers = await startInProcessWorkers(1);
    await eventually(async () =>
      expect(await ctx.ds.getRepository(StepRun).findOneByOrFail({ executionId: execution.id })).toMatchObject({ status: 'waiting' }),
    );

    await ctx.ds.getRepository(Workflow).delete(execution.workflowId);
    await ctx.ds.getRepository(Job).update(job.id, { runAt: new Date(Date.now() - 1_000) });

    await eventually(async () =>
      expect(await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id })).toMatchObject({ status: 'failed' }),
    );
    expect(await ctx.ds.getRepository(StepRun).findOneByOrFail({ executionId: execution.id })).toMatchObject({ status: 'failed' });
  });

  it('completes a zero-length delay and records the waited time', async () => {
    const { execution } = await enqueue('zero-delay', 0);
    workers = await startInProcessWorkers(1);

    await eventually(async () =>
      expect(await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id })).toMatchObject({ status: 'succeeded' }),
    );
    expect(await ctx.ds.getRepository(StepRun).findOneByOrFail({ executionId: execution.id, stepIndex: 0 })).toMatchObject({
      status: 'succeeded',
      output: { waitedMs: 0 },
    });
  });
});

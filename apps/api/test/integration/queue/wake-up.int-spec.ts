import { DataSource } from 'typeorm';
import { TenantDb } from '../../../src/db/tenant-db.service';
import { JobQueueService } from '../../../src/engine/job-queue.service';
import { Execution, Job, StepRun } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { openDataSource, seedTenant, seedWorkflow } from '../../support/db';

describe('waking up a due delay step', () => {
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

  it('resumes the job in the same claim instead of queueing it again', async () => {
    const { tenant } = await seedTenant(ctx.ds, 'wake-up');
    const workflow = await seedWorkflow(ctx.ds, tenant.id, [{ id: 'pause', type: 'delay', ms: 10 }]);
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.id, workflowId: workflow.id, input: {}, status: 'running' });
    const job = await ctx.ds.getRepository(Job).save({
      tenantId: tenant.id,
      executionId: execution.id,
      status: 'running',
      attempts: 1,
      lockedBy: 'worker-a',
      lockedUntil: new Date(Date.now() + 60_000),
    });
    await ctx.ds.getRepository(StepRun).save({
      tenantId: tenant.id,
      executionId: execution.id,
      stepIndex: 0,
      stepId: 'pause',
      status: 'waiting',
      attempts: 1,
      wakeAt: new Date(Date.now() - 1_000),
    });

    const outcome = await queue.wakeUp(job, 'worker-a', 0, { waitedMs: 10 });

    expect(outcome).toBe('resumed');
    expect(await ctx.ds.getRepository(Job).findOneByOrFail({ id: job.id })).toMatchObject({ status: 'running', lockedBy: 'worker-a', attempts: 1 });
    expect(await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id })).toMatchObject({ status: 'running' });
  });
});

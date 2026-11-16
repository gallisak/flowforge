import { JobQueueService } from '../../../src/engine/job-queue.service';
import { Execution, Job } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

describe('fencing tokens of job claims', () => {
  const ctx = useIntegrationContext();
  let workers: InProcessWorkers | undefined;

  afterEach(async () => {
    jest.restoreAllMocks();
    await workers?.stop();
  });

  it('gives every claim of the same job by the same worker its own token, even when a delay gave the attempt back', async () => {
    const claims: Array<{ lockedBy: string | null; attempts: number }> = [];
    const claimNext = JobQueueService.prototype.claimNext;
    jest.spyOn(JobQueueService.prototype, 'claimNext').mockImplementation(async function (this: JobQueueService, ...args) {
      const job = await claimNext.apply(this, args);
      if (job) claims.push({ lockedBy: job.lockedBy, attempts: job.attempts });
      return job;
    });
    const { tenant } = await seedTenant(ctx.ds, 'claim-tokens');
    const workflow = await seedWorkflow(ctx.ds, tenant.id, [
      { id: 'pause', type: 'delay', ms: 200 },
      { id: 'note', type: 'log', message: 'done' },
    ]);
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.id, workflowId: workflow.id, input: {} });
    await ctx.ds.getRepository(Job).save({ tenantId: tenant.id, executionId: execution.id });

    workers = await startInProcessWorkers(1);
    await eventually(async () => expect(await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id })).toMatchObject({ status: 'succeeded' }));

    expect(claims).toHaveLength(2);
    expect(claims[0].attempts).toBe(claims[1].attempts);
    expect(claims[0].lockedBy).not.toBe(claims[1].lockedBy);
    expect(claims.every((claim) => claim.lockedBy?.startsWith(workers?.ids[0] ?? '?'))).toBe(true);
  });
});

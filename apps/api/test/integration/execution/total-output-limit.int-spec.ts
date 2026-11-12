import { Execution, Job, StepRun } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

describe('total size of the outputs of one execution', () => {
  const ctx = useIntegrationContext();
  let workers: InProcessWorkers;
  const names = ['STEP_OUTPUT_MAX_BYTES', 'EXECUTION_OUTPUT_MAX_BYTES', 'TRANSFORM_TIMEOUT_MS'] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));

  beforeAll(async () => {
    process.env.STEP_OUTPUT_MAX_BYTES = '102400';
    process.env.EXECUTION_OUTPUT_MAX_BYTES = '300000';
    process.env.TRANSFORM_TIMEOUT_MS = '1000';
    workers = await startInProcessWorkers(1);
  });

  afterAll(async () => {
    await workers?.stop();
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it('fails the execution without a retry once its stored outputs would pass the limit', async () => {
    const { tenant } = await seedTenant(ctx.ds, 'total-output');
    const workflow = await seedWorkflow(
      ctx.ds,
      tenant.id,
      ['a', 'b', 'c', 'd'].map((id) => ({ id, type: 'transform' as const, expr: '"x".repeat(100000)' })),
    );
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.id, workflowId: workflow.id, input: {} });
    const job = await ctx.ds.getRepository(Job).save({ tenantId: tenant.id, executionId: execution.id });

    const finished = await eventually(async () => {
      const current = await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id });
      expect(['succeeded', 'failed']).toContain(current.status);
      return current;
    });

    expect(finished.status).toBe('failed');
    expect(finished.error).toBe('the outputs of this execution would exceed 300000 bytes in total');
    expect(await ctx.ds.getRepository(Job).findOneByOrFail({ id: job.id })).toMatchObject({ status: 'failed', attempts: 1 });
    const stored = await ctx.ds.getRepository(StepRun).find({ where: { executionId: execution.id, status: 'succeeded' } });
    expect(stored.map((s) => s.stepId).sort()).toEqual(['a', 'b']);
  });
});

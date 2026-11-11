import { Client } from 'pg';
import { Execution, Job, StepRun } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow } from '../../support/db';

describe('lease reaper keeps execution and step states consistent', () => {
  const ctx = useIntegrationContext();
  let app: Client;

  beforeAll(async () => {
    app = new Client({ connectionString: ctx.db.url });
    await app.connect();
    ctx.onTeardown(() => app.end());
  });

  async function seedAbandonedStep(name: string, attempts: number) {
    const { tenant } = await seedTenant(ctx.ds, name);
    const workflow = await seedWorkflow(ctx.ds, tenant.id, [
      { id: 'first', type: 'log', message: 'one' },
      { id: 'second', type: 'log', message: 'two' },
    ]);
    const execution = await ctx.ds
      .getRepository(Execution)
      .save({ tenantId: tenant.id, workflowId: workflow.id, status: 'running', input: {} });
    await ctx.ds.getRepository(StepRun).save([
      { tenantId: tenant.id, executionId: execution.id, stepIndex: 0, stepId: 'first', status: 'succeeded', attempts: 1, output: {} },
      { tenantId: tenant.id, executionId: execution.id, stepIndex: 1, stepId: 'second', status: 'running', attempts: 1 },
    ]);
    await ctx.ds.getRepository(Job).save({
      tenantId: tenant.id,
      executionId: execution.id,
      status: 'running',
      attempts,
      maxAttempts: 3,
      lockedBy: 'worker-that-died',
      lockedUntil: new Date(Date.now() - 60_000),
    });
    return execution;
  }

  const stepsOf = async (executionId: string) =>
    (await ctx.ds.getRepository(StepRun).find({ where: { executionId }, order: { stepIndex: 'ASC' } })).map((s) => ({
      stepId: s.stepId,
      status: s.status,
    }));

  it('shows a requeued execution as pending and its interrupted step as failed', async () => {
    const execution = await seedAbandonedStep('reaped-requeued', 1);

    await app.query('SELECT * FROM reap_expired_jobs()');

    expect(await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id })).toMatchObject({
      status: 'pending',
      error: expect.stringMatching(/lease expired/),
    });
    expect(await stepsOf(execution.id)).toEqual([
      { stepId: 'first', status: 'succeeded' },
      { stepId: 'second', status: 'failed' },
    ]);
  });

  it('leaves no running step behind an execution that failed because its job is dead', async () => {
    const execution = await seedAbandonedStep('reaped-dead', 3);

    await app.query('SELECT * FROM reap_expired_jobs()');

    expect(await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id })).toMatchObject({ status: 'failed' });
    expect(await stepsOf(execution.id)).toEqual([
      { stepId: 'first', status: 'succeeded' },
      { stepId: 'second', status: 'failed' },
    ]);
  });
});

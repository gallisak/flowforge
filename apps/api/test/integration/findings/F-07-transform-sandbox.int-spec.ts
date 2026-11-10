import { Execution, Job } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { spawnWorkerProcess, WorkerProcess } from '../../support/worker';

describe('F-07 a transform step cannot run code on the host', () => {
  const ctx = useIntegrationContext();
  let worker: WorkerProcess;

  async function runTransform(expr: string, timeoutMs = 20_000): Promise<Execution> {
    const { tenant } = await seedTenant(ctx.ds, `transform-${Date.now()}-${Math.random()}`);
    const workflow = await seedWorkflow(ctx.ds, tenant.id, [{ id: 'shape', type: 'transform', expr }]);
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.id, workflowId: workflow.id, input: {} });
    await ctx.ds.getRepository(Job).save({ tenantId: tenant.id, executionId: execution.id });
    return eventually(
      async () => {
        const current = await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id });
        expect(['succeeded', 'failed']).toContain(current.status);
        return current;
      },
      { timeoutMs },
    );
  }

  beforeAll(() => {
    worker = spawnWorkerProcess({ DATABASE_URL: ctx.db.url, WORKER_CONCURRENCY: '1' });
  });

  afterAll(async () => {
    await worker?.kill('SIGKILL');
  });

  it('cannot reach the host process through the function constructor', async () => {
    const execution = await runTransform("ctx.constructor.constructor('return process')().env.DATABASE_URL");

    expect(execution.status).toBe('failed');
    expect(JSON.stringify(execution)).not.toContain(ctx.db.url);
  });

  it('sees none of the host globals', async () => {
    const execution = await runTransform('[typeof process, typeof globalThis.process, typeof Buffer, typeof setTimeout]');

    expect(execution).toMatchObject({ status: 'succeeded', output: ['undefined', 'undefined', 'undefined', 'undefined'] });
  });

  it('stops an endless loop and keeps the worker serving other executions', async () => {
    const looping = await runTransform('(() => { while (true) {} })()', 10_000);
    expect(looping.status).toBe('failed');
    expect(looping.error).toMatch(/time/i);

    const next = await runTransform('ctx.input', 5_000);
    expect(next.status).toBe('succeeded');
  });
});

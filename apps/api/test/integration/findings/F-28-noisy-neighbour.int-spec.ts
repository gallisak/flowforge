import { Execution, Job } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

const BACKLOG = 400;

describe('F-28 a tenant with a large backlog does not hold up other tenants', () => {
  const ctx = useIntegrationContext();
  let workers: InProcessWorkers;

  async function enqueueMany(tenantName: string, count: number): Promise<{ tenantId: string; executionIds: string[] }> {
    const { tenant } = await seedTenant(ctx.ds, tenantName);
    const workflow = await seedWorkflow(ctx.ds, tenant.id, [{ id: 'note', type: 'log', message: 'work' }]);
    const executions = await ctx.ds
      .getRepository(Execution)
      .save(Array.from({ length: count }, () => ({ tenantId: tenant.id, workflowId: workflow.id, input: {} })), { chunk: 200 });
    await ctx.ds
      .getRepository(Job)
      .save(executions.map((e) => ({ tenantId: tenant.id, executionId: e.id })), { chunk: 200 });
    return { tenantId: tenant.id, executionIds: executions.map((e) => e.id) };
  }

  const unfinished = (tenantId: string) => ctx.ds.getRepository(Job).countBy({ tenantId, status: 'queued' });

  afterAll(async () => {
    await workers?.stop();
  });

  it('serves a tenant that arrives after a large backlog of another tenant without waiting for it', async () => {
    const noisy = await enqueueMany('noisy', BACKLOG);
    workers = await startInProcessWorkers(1, 2);
    await eventually(async () => expect(await unfinished(noisy.tenantId)).toBeLessThan(BACKLOG));

    const quiet = await enqueueMany('quiet', 3);
    await eventually(
      async () =>
        expect(await ctx.ds.getRepository(Job).countBy({ tenantId: quiet.tenantId, status: 'done' })).toBe(quiet.executionIds.length),
      { timeoutMs: 60_000 },
    );

    expect(await unfinished(noisy.tenantId)).toBeGreaterThan(BACKLOG / 2);
  });
});

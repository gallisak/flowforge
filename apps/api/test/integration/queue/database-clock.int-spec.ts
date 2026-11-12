import { Execution, Job } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('timestamps written by a worker whose clock is behind', () => {
  const ctx = useIntegrationContext();
  let workers: InProcessWorkers;

  beforeAll(async () => {
    jest.useFakeTimers({ now: Date.now() - DAY_MS, advanceTimers: true, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'performance', 'hrtime'] });
    workers = await startInProcessWorkers(1);
  });

  afterAll(async () => {
    await workers?.stop();
    jest.useRealTimers();
  });

  it.each([
    ['succeeded', [{ id: 'note', type: 'log' as const, message: 'hi' }]],
    ['failed', [{ id: 'boom', type: 'transform' as const, expr: '(() => { throw new Error("no") })()' }]],
  ])('take the finish time of a %s execution from the database', async (status, steps) => {
    const { tenant } = await seedTenant(ctx.ds, `clock-${status}`);
    const workflow = await seedWorkflow(ctx.ds, tenant.id, steps);
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.id, workflowId: workflow.id, input: {} });
    await ctx.ds.getRepository(Job).save({ tenantId: tenant.id, executionId: execution.id });

    const finished = await eventually(async () => {
      const current = await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id });
      expect(current.status).toBe(status);
      return current;
    });

    expect(finished.finishedAt?.getTime()).toBeGreaterThanOrEqual(finished.createdAt.getTime());
  });
});

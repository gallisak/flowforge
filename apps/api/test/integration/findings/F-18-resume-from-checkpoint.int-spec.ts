import { Execution, Job, StepRun } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { Receiver, startReceiver } from '../../support/receiver';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

describe('F-18 a retried execution resumes from its first unfinished step', () => {
  const ctx = useIntegrationContext();
  let receiver: Receiver;
  let workers: InProcessWorkers | undefined;
  let execution: Execution;
  let flakyCalls = 0;
  const saved = { base: process.env.RETRY_BASE_MS, cap: process.env.RETRY_CAP_MS };

  const hits = (path: string) => receiver.requests.filter((r) => r.path === path).length;

  beforeAll(async () => {
    process.env.RETRY_BASE_MS = '100';
    process.env.RETRY_CAP_MS = '200';
    receiver = await startReceiver((req, res) => {
      const status = req.path === '/flaky' && flakyCalls++ === 0 ? 503 : 200;
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ path: req.path }));
    });
    const { tenant } = await seedTenant(ctx.ds, 'resumes');
    const workflow = await seedWorkflow(ctx.ds, tenant.id, [
      { id: 'charge', type: 'http', url: `${receiver.url}/once`, method: 'POST' },
      { id: 'notify', type: 'http', url: `${receiver.url}/flaky`, method: 'POST' },
      { id: 'done', type: 'log', message: 'charged {{ steps.charge.body.path }}' },
    ]);
    execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.id, workflowId: workflow.id, input: {} });
    await ctx.ds.getRepository(Job).save({ tenantId: tenant.id, executionId: execution.id });

    workers = await startInProcessWorkers(1);
    await eventually(async () =>
      expect(await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id })).toMatchObject({ status: 'succeeded' }),
    );
  });

  afterAll(async () => {
    await workers?.stop();
    await receiver?.close();
    for (const [name, value] of [
      ['RETRY_BASE_MS', saved.base],
      ['RETRY_CAP_MS', saved.cap],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('does not repeat a step that already succeeded', () => {
    expect(hits('/once')).toBe(1);
    expect(hits('/flaky')).toBe(2);
  });

  it('keeps exactly one record per step, all finished', async () => {
    const runs = await ctx.ds.getRepository(StepRun).find({ where: { executionId: execution.id }, order: { stepIndex: 'ASC' } });
    expect(runs.map((r) => [r.stepIndex, r.stepId, r.status])).toEqual([
      [0, 'charge', 'succeeded'],
      [1, 'notify', 'succeeded'],
      [2, 'done', 'succeeded'],
    ]);
  });

  it('feeds the stored result of the earlier step into later steps', async () => {
    const runs = await ctx.ds.getRepository(StepRun).findBy({ executionId: execution.id, stepId: 'done' });
    expect(runs.map((r) => r.output)).toEqual([{ logged: true }]);
    const stored = await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id });
    expect(stored.output).toEqual({ logged: true });
  });
});

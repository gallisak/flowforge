import { Execution, Job, StepRun } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { Receiver, startReceiver } from '../../support/receiver';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

describe('idempotency keys of http steps', () => {
  const ctx = useIntegrationContext();
  let receiver: Receiver;
  let workers: InProcessWorkers;
  let failFirstCall = true;
  const saved = { base: process.env.RETRY_BASE_MS, cap: process.env.RETRY_CAP_MS };

  async function run(steps: Parameters<typeof seedWorkflow>[2]): Promise<Execution> {
    const { tenant } = await seedTenant(ctx.ds, `keys-${Date.now()}-${Math.random()}`);
    const workflow = await seedWorkflow(ctx.ds, tenant.id, steps);
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.id, workflowId: workflow.id, input: {} });
    await ctx.ds.getRepository(Job).save({ tenantId: tenant.id, executionId: execution.id });
    await eventually(async () =>
      expect(await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id })).toMatchObject({ status: 'succeeded' }),
    );
    return execution;
  }

  const keysFor = (path: string) => receiver.requests.filter((r) => r.path === path).map((r) => r.headers['idempotency-key']);

  beforeAll(async () => {
    process.env.RETRY_BASE_MS = '50';
    process.env.RETRY_CAP_MS = '100';
    receiver = await startReceiver((req, res) => {
      if (req.path === '/flaky' && failFirstCall) {
        failFirstCall = false;
        res.writeHead(503).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
    workers = await startInProcessWorkers(1);
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

  it('sends the same key on every attempt of a step', async () => {
    const execution = await run([{ id: 'charge', type: 'http', url: `${receiver.url}/flaky`, method: 'POST' }]);

    expect(keysFor('/flaky')).toEqual([`${execution.id}:charge`, `${execution.id}:charge`]);
    expect(await ctx.ds.getRepository(StepRun).findOneByOrFail({ executionId: execution.id })).toMatchObject({
      idempotencyKey: `${execution.id}:charge`,
      attempts: 2,
    });
  });

  it('uses different keys for different steps and different executions', async () => {
    const steps = [
      { id: 'first', type: 'http' as const, url: `${receiver.url}/distinct-a` },
      { id: 'second', type: 'http' as const, url: `${receiver.url}/distinct-b` },
    ];
    const one = await run(steps);
    const two = await run(steps);

    expect(keysFor('/distinct-a')).toEqual([`${one.id}:first`, `${two.id}:first`]);
    expect(keysFor('/distinct-b')).toEqual([`${one.id}:second`, `${two.id}:second`]);
  });

  it('replaces a key the tenant tried to set on the step', async () => {
    const execution = await run([
      { id: 'call', type: 'http', url: `${receiver.url}/tenant-header`, headers: { 'IDEMPOTENCY-KEY': 'fixed-by-tenant' } },
    ]);

    expect(keysFor('/tenant-header')).toEqual([`${execution.id}:call`]);
  });

  it('does not assign keys to steps without side effects', async () => {
    const execution = await run([{ id: 'note', type: 'log', message: 'no side effect' }]);
    expect(await ctx.ds.getRepository(StepRun).findOneByOrFail({ executionId: execution.id })).toMatchObject({ idempotencyKey: null });
  });
});

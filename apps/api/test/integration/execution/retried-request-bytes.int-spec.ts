import { Execution, Job } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { Receiver, startReceiver } from '../../support/receiver';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

describe('a retried http step', () => {
  const ctx = useIntegrationContext();
  let receiver: Receiver;
  let workers: InProcessWorkers;
  let chargeCalls = 0;
  const saved = { base: process.env.RETRY_BASE_MS, cap: process.env.RETRY_CAP_MS };

  beforeAll(async () => {
    process.env.RETRY_BASE_MS = '50';
    process.env.RETRY_CAP_MS = '100';
    receiver = await startReceiver((req, res) => {
      if (req.path === '/order') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"order":{"amount":10,"currency":"EUR","id":"x"}}');
        return;
      }
      chargeCalls++;
      if (chargeCalls === 1) res.writeHead(503).end();
      else res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
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

  it('sends the same body with the same idempotency key on every attempt', async () => {
    const { tenant } = await seedTenant(ctx.ds, 'retried-bytes');
    const workflow = await seedWorkflow(ctx.ds, tenant.id, [
      { id: 'order', type: 'http', url: `${receiver.url}/order` },
      { id: 'charge', type: 'http', method: 'POST', url: `${receiver.url}/charge`, body: '{"order": {{steps.order.body.order}}}' },
    ]);
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.id, workflowId: workflow.id, input: {} });
    await ctx.ds.getRepository(Job).save({ tenantId: tenant.id, executionId: execution.id });

    await eventually(async () => expect(await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id })).toMatchObject({ status: 'succeeded' }));

    const charges = receiver.requests.filter((r) => r.path === '/charge');
    expect(charges).toHaveLength(2);
    expect(charges[1].headers['idempotency-key']).toBe(charges[0].headers['idempotency-key']);
    expect(charges[1].body).toBe(charges[0].body);
  });
});

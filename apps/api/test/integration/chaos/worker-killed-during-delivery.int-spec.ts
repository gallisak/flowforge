import { Execution, Job, NotificationEndpoint, OutboxEvent, WebhookSecret } from '../../../src/entities';
import { generateWebhookSecret } from '../../../src/webhooks/webhook-secrets.service';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { RecordedRequest, Receiver, startReceiver } from '../../support/receiver';
import { InProcessWorkers, spawnWorkerProcess, startInProcessWorkers, WorkerProcess } from '../../support/worker';

describe('chaos: a worker is killed while it delivers a notification', () => {
  const ctx = useIntegrationContext();
  let receiver: Receiver;
  let spawned: WorkerProcess | undefined;
  let workers: InProcessWorkers | undefined;
  const deliveries: RecordedRequest[] = [];
  const saved = { lease: process.env.OUTBOX_LEASE_SECONDS, timeout: process.env.OUTBOX_TIMEOUT_MS };

  afterAll(async () => {
    await spawned?.kill('SIGKILL');
    await workers?.stop();
    await receiver?.close();
    for (const [name, value] of [
      ['OUTBOX_LEASE_SECONDS', saved.lease],
      ['OUTBOX_TIMEOUT_MS', saved.timeout],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('delivers the notification again with the same event id after the lease expires', async () => {
    process.env.OUTBOX_LEASE_SECONDS = '2';
    process.env.OUTBOX_TIMEOUT_MS = '1500';
    receiver = await startReceiver((req, res) => {
      deliveries.push(req);
      if (deliveries.length > 1) res.writeHead(200).end();
    });
    const { tenant } = await seedTenant(ctx.ds, 'chaos-delivery');
    await ctx.ds.getRepository(NotificationEndpoint).save({ tenantId: tenant.id, url: `${receiver.url}/notify` });
    await ctx.ds.getRepository(WebhookSecret).save({ tenantId: tenant.id, purpose: 'outbound', secret: generateWebhookSecret() });
    const workflow = await seedWorkflow(ctx.ds, tenant.id, [{ id: 'note', type: 'log', message: 'hi' }]);
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.id, workflowId: workflow.id, input: {} });
    await ctx.ds.getRepository(Job).save({ tenantId: tenant.id, executionId: execution.id });

    spawned = spawnWorkerProcess({
      DATABASE_URL: ctx.db.url,
      WORKER_CONCURRENCY: '1',
      OUTBOX_LEASE_SECONDS: '2',
      OUTBOX_TIMEOUT_MS: '1500',
    });
    await eventually(() => expect(deliveries).toHaveLength(1), { timeoutMs: 20_000 });
    expect((await spawned.kill('SIGKILL')).signal).toBe('SIGKILL');
    spawned = undefined;

    workers = await startInProcessWorkers(1);

    const event = await eventually(
      async () => {
        const current = await ctx.ds.getRepository(OutboxEvent).findOneByOrFail({ executionId: execution.id });
        expect(current).toMatchObject({ status: 'delivered', attempts: 2 });
        return current;
      },
      { timeoutMs: 20_000 },
    );
    expect(deliveries).toHaveLength(2);
    expect(deliveries.map((delivery) => delivery.headers['webhook-id'])).toEqual([event.id, event.id]);
  });
});

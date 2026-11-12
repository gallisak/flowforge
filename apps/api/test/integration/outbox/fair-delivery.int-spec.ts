import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Execution, OutboxEvent } from '../../../src/entities';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { Receiver, startReceiver } from '../../support/receiver';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

describe('notification delivery across tenants', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let receiver: Receiver;
  let workers: InProcessWorkers | undefined;
  const saved = { timeout: process.env.OUTBOX_TIMEOUT_MS };

  async function withEndpoint(name: string, path: string): Promise<SeededTenant> {
    const owner = await seedTenant(ctx.ds, name);
    await request(app.getHttpServer())
      .put('/notifications/endpoint')
      .set('x-api-key', owner.apiKey)
      .send({ url: `${receiver.url}${path}` })
      .expect(200);
    return owner;
  }

  async function pending(tenantId: string, count: number, at: Date): Promise<void> {
    const workflow = await seedWorkflow(ctx.ds, tenantId, [{ id: 'note', type: 'log', message: 'x' }]);
    const executions = await ctx.ds
      .getRepository(Execution)
      .save(Array.from({ length: count }, () => ({ tenantId, workflowId: workflow.id, input: {}, status: 'succeeded' as const })));
    await ctx.ds.getRepository(OutboxEvent).insert(
      executions.map((execution) => ({
        tenantId,
        executionId: execution.id,
        type: 'execution.succeeded',
        payload: {},
        nextAttemptAt: at,
      })),
    );
  }

  beforeAll(async () => {
    process.env.OUTBOX_TIMEOUT_MS = '1000';
    app = await createTestApp();
    receiver = await startReceiver((req, res) => {
      if (req.path === '/slow') return;
      res.writeHead(204);
      res.end();
    });
  });

  afterAll(async () => {
    await workers?.stop();
    await receiver?.close();
    await app?.close();
    if (saved.timeout === undefined) delete process.env.OUTBOX_TIMEOUT_MS;
    else process.env.OUTBOX_TIMEOUT_MS = saved.timeout;
  });

  it('delivers the notification of one tenant while the endpoint of another tenant hangs', async () => {
    const slow = await withEndpoint('slow-endpoint', '/slow');
    const fast = await withEndpoint('fast-endpoint', '/fast');
    await pending(slow.tenant.id, 40, new Date(Date.now() - 60_000));
    await pending(fast.tenant.id, 1, new Date());

    const started = Date.now();
    workers = await startInProcessWorkers(1);

    await eventually(() => expect(receiver.requests.filter((r) => r.path === '/fast')).toHaveLength(1), { timeoutMs: 10_000 });
    expect(Date.now() - started).toBeLessThan(2_000);
    const inFlightForSlow = receiver.requests.filter((r) => r.path === '/slow').length;
    expect(inFlightForSlow).toBeLessThanOrEqual(2);
  });
});

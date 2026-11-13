import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { INTERNAL_WORKER_ERROR } from '../../../src/engine/job-runner.service';
import { Execution, Job, OutboxEvent } from '../../../src/entities';
import { verifyWebhook } from '../../../src/webhooks/signature';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant, seedWorkflow } from '../../support/db';
import { consistently, eventually } from '../../support/eventually';
import { RecordedRequest, Receiver, startReceiver } from '../../support/receiver';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

type Steps = Parameters<typeof seedWorkflow>[2];

describe('execution notifications', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let receiver: Receiver;
  let workers: InProcessWorkers;
  let tenant: SeededTenant;
  let secret: string;
  const saved = { ...process.env };

  const api = () => request(app.getHttpServer());
  const deliveriesOf = (executionId: string) =>
    receiver.requests.filter((r) => r.path === '/notify' && JSON.parse(r.body).data.executionId === executionId);

  async function execute(owner: SeededTenant, steps: Steps): Promise<Execution> {
    const workflow = await seedWorkflow(ctx.ds, owner.tenant.id, steps);
    const execution = await ctx.ds.getRepository(Execution).save({
      tenantId: owner.tenant.id,
      workflowId: workflow.id,
      input: {},
      correlationId: `corr-${workflow.id}`,
    });
    await ctx.ds.getRepository(Job).save({ tenantId: owner.tenant.id, executionId: execution.id });
    return eventually(async () => {
      const current = await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id });
      expect(['succeeded', 'failed']).toContain(current.status);
      return current;
    });
  }

  async function deliveredOnce(executionId: string): Promise<RecordedRequest> {
    return eventually(async () => {
      const [delivery] = deliveriesOf(executionId);
      expect(delivery).toBeDefined();
      expect(await ctx.ds.getRepository(OutboxEvent).findOneByOrFail({ executionId })).toMatchObject({ status: 'delivered' });
      return delivery;
    });
  }

  function verify(delivery: RecordedRequest, secrets: string[]): string | undefined {
    return verifyWebhook(
      secrets,
      {
        id: String(delivery.headers['webhook-id']),
        timestamp: String(delivery.headers['webhook-timestamp']),
        signature: String(delivery.headers['webhook-signature']),
      },
      Buffer.from(delivery.body),
      Math.floor(Date.now() / 1000),
      300,
    );
  }

  beforeAll(async () => {
    process.env.OUTBOX_MAX_ATTEMPTS = '3';
    process.env.RETRY_BASE_MS = '50';
    process.env.RETRY_CAP_MS = '100';
    app = await createTestApp();
    receiver = await startReceiver();
    tenant = await seedTenant(ctx.ds, 'notified');
    const configured = await api()
      .put('/notifications/endpoint')
      .set('x-api-key', tenant.apiKey)
      .send({ url: `${receiver.url}/notify` })
      .expect(200);
    secret = configured.body.secret;
    workers = await startInProcessWorkers(1, 2);
  });

  afterEach(() => {
    receiver.setHandler((_req, res) => {
      res.writeHead(200).end();
    });
  });

  afterAll(async () => {
    await workers?.stop();
    await app?.close();
    await receiver?.close();
    process.env = saved;
  });

  it('shows the signing secret only when the endpoint is first configured', async () => {
    expect(secret).toMatch(/^whsec_/);

    const again = await api().put('/notifications/endpoint').set('x-api-key', tenant.apiKey).send({ url: `${receiver.url}/notify` });
    const shown = await api().get('/notifications/endpoint').set('x-api-key', tenant.apiKey).expect(200);
    const listed = await api().get('/notifications/secrets').set('x-api-key', tenant.apiKey).expect(200);

    expect(again.status).toBe(200);
    expect(again.body.secret).toBeUndefined();
    expect(shown.body).toEqual({ url: `${receiver.url}/notify`, updatedAt: expect.any(String) });
    expect(listed.body).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(secret);
  });

  it.each([
    ['text that is not a url', 'not a url'],
    ['a non http scheme', 'ftp://example.com/hook'],
    ['credentials in the url', 'https://user:pass@example.com/hook'],
    ['a url that is too long', `https://example.com/${'a'.repeat(2100)}`],
  ])('rejects an endpoint with %s', async (_case, url) => {
    await api().put('/notifications/endpoint').set('x-api-key', tenant.apiKey).send({ url }).expect(400);
  });

  it('keeps endpoints separate per tenant', async () => {
    const other = await seedTenant(ctx.ds, 'not-notified');

    await api().get('/notifications/endpoint').set('x-api-key', other.apiKey).expect(404);
    await api().delete('/notifications/endpoint').set('x-api-key', other.apiKey).expect(404);
  });

  it('sends a signed notification when an execution succeeds', async () => {
    const execution = await execute(tenant, [{ id: 'shape', type: 'transform', expr: '({ total: 42 })' }]);

    const delivery = await deliveredOnce(execution.id);
    const event = await ctx.ds.getRepository(OutboxEvent).findOneByOrFail({ executionId: execution.id });

    expect(verify(delivery, [secret])).toBe(event.id);
    expect(delivery.headers['content-type']).toBe('application/json');
    expect(delivery.headers['x-correlation-id']).toBe(`corr-${execution.workflowId}`);
    expect(JSON.parse(delivery.body)).toEqual({
      type: 'execution.succeeded',
      timestamp: expect.any(String),
      data: expect.objectContaining({
        executionId: execution.id,
        workflowId: execution.workflowId,
        status: 'succeeded',
        output: { total: 42 },
        outputTruncated: false,
        error: null,
      }),
    });
  });

  it('sends a notification when an execution fails', async () => {
    const execution = await execute(tenant, [{ id: 'shape', type: 'transform', expr: '(() => { throw new Error("boom"); })()' }]);

    const delivery = await deliveredOnce(execution.id);

    expect(JSON.parse(delivery.body)).toMatchObject({
      type: 'execution.failed',
      data: { status: 'failed', error: expect.stringContaining('boom') },
    });
  });

  it('leaves out an output that is too large to send', async () => {
    const execution = await execute(tenant, [{ id: 'shape', type: 'transform', expr: '"x".repeat(70000)' }]);

    const delivery = await deliveredOnce(execution.id);

    expect(JSON.parse(delivery.body).data).toMatchObject({ output: null, outputTruncated: true });
  });

  it('retries a failed delivery with the same event id until the endpoint accepts it', async () => {
    let calls = 0;
    receiver.setHandler((_req, res) => {
      res.writeHead(++calls <= 2 ? 500 : 204).end();
    });

    const execution = await execute(tenant, [{ id: 'note', type: 'log', message: 'hi' }]);

    await eventually(async () =>
      expect(await ctx.ds.getRepository(OutboxEvent).findOneByOrFail({ executionId: execution.id })).toMatchObject({
        status: 'delivered',
        attempts: 3,
        lastStatusCode: 204,
      }),
    );
    const ids = deliveriesOf(execution.id).map((delivery) => delivery.headers['webhook-id']);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
  });

  it('gives up on an endpoint that keeps failing after the configured attempts', async () => {
    receiver.setHandler((_req, res) => {
      res.writeHead(503).end();
    });

    const execution = await execute(tenant, [{ id: 'note', type: 'log', message: 'hi' }]);

    await eventually(async () =>
      expect(await ctx.ds.getRepository(OutboxEvent).findOneByOrFail({ executionId: execution.id })).toMatchObject({
        status: 'dead',
        attempts: 3,
        lastError: 'endpoint answered 503',
      }),
    );
    expect(deliveriesOf(execution.id)).toHaveLength(3);

    const listed = await api().get('/notifications/events?status=dead').set('x-api-key', tenant.apiKey).expect(200);
    expect(listed.body).toContainEqual(
      expect.objectContaining({ executionId: execution.id, status: 'dead', attempts: 3, lastError: 'endpoint answered 503', lastStatusCode: 503 }),
    );
    expect(listed.body.every((event: Record<string, unknown>) => !('payload' in event) && event.status === 'dead')).toBe(true);
  });

  it('tells the tenant that the endpoint redirects instead of reporting a connection error', async () => {
    receiver.setHandler((_req, res) => {
      res.writeHead(302, { location: 'https://example.com/elsewhere' }).end();
    });

    const execution = await execute(tenant, [{ id: 'note', type: 'log', message: 'hi' }]);

    await eventually(async () =>
      expect(await ctx.ds.getRepository(OutboxEvent).findOneByOrFail({ executionId: execution.id })).toMatchObject({
        lastError: 'endpoint answered with a redirect; notifications do not follow redirects',
      }),
    );
  });

  it('records a broken connection without the text of the network error', async () => {
    receiver.setHandler((_req, res) => {
      res.socket?.destroy();
    });

    const execution = await execute(tenant, [{ id: 'note', type: 'log', message: 'hi' }]);

    await eventually(async () =>
      expect(await ctx.ds.getRepository(OutboxEvent).findOneByOrFail({ executionId: execution.id })).toMatchObject({
        status: 'dead',
        lastError: 'delivery failed: connection error',
      }),
    );
  });

  it.each([
    'http://169.254.169.254/latest',
    'http://localhost:1/x',
    'http://10.0.0.1/hook',
    'http://[::1]:8080/hook',
    'http://[fd00:ec2::254]/hook',
  ])('refuses %s as a notification endpoint, since no notification could ever be delivered there', async (url) => {
    const owner = await seedTenant(ctx.ds, `private-endpoint-${Math.random()}`);

    const refused = await api().put('/notifications/endpoint').set('x-api-key', owner.apiKey).send({ url }).expect(400);

    expect(refused.body.message).toBe('url must point to a public internet address');
    await api().get('/notifications/endpoint').set('x-api-key', owner.apiKey).expect(404);
  });

  it('records no notification for a tenant without an endpoint', async () => {
    const quiet = await seedTenant(ctx.ds, 'quiet');

    const execution = await execute(quiet, [{ id: 'note', type: 'log', message: 'hi' }]);

    await consistently(async () => expect(await ctx.ds.getRepository(OutboxEvent).countBy({ executionId: execution.id })).toBe(0), {
      timeoutMs: 500,
    });
  });

  it('records the notification in the same transaction as the final state of the execution', async () => {
    await ctx.ds.query(`
      CREATE FUNCTION refuse_outbox_events() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'outbox is unavailable'; END $$
    `);
    await ctx.ds.query(`CREATE TRIGGER refuse_outbox_events BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION refuse_outbox_events()`);
    const workflow = await seedWorkflow(ctx.ds, tenant.tenant.id, [{ id: 'note', type: 'log', message: 'hi' }]);
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.tenant.id, workflowId: workflow.id, input: {} });
    const job = await ctx.ds.getRepository(Job).save({ tenantId: tenant.tenant.id, executionId: execution.id, maxAttempts: 10 });

    try {
      await eventually(async () =>
        expect((await ctx.ds.getRepository(Job).findOneByOrFail({ id: job.id })).lastError).toBe(INTERNAL_WORKER_ERROR),
      );
      expect(await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id })).not.toMatchObject({ status: 'succeeded' });
      expect(await ctx.ds.getRepository(OutboxEvent).countBy({ executionId: execution.id })).toBe(0);
    } finally {
      await ctx.ds.query('DROP TRIGGER refuse_outbox_events ON outbox_events');
      await ctx.ds.query('DROP FUNCTION refuse_outbox_events()');
    }

    await deliveredOnce(execution.id);
    expect(await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id })).toMatchObject({ status: 'succeeded' });
    expect(await ctx.ds.getRepository(OutboxEvent).countBy({ executionId: execution.id })).toBe(1);
  });

  it('notifies about an execution that failed because its worker kept disappearing', async () => {
    const workflow = await seedWorkflow(ctx.ds, tenant.tenant.id, [{ id: 'note', type: 'log', message: 'hi' }]);
    const execution = await ctx.ds.getRepository(Execution).save({
      tenantId: tenant.tenant.id,
      workflowId: workflow.id,
      input: {},
      status: 'running',
    });
    await ctx.ds.getRepository(Job).save({
      tenantId: tenant.tenant.id,
      executionId: execution.id,
      status: 'running',
      attempts: 3,
      maxAttempts: 3,
      lockedBy: 'worker-that-died',
      lockedUntil: new Date(Date.now() - 60_000),
    });

    const delivery = await deliveredOnce(execution.id);

    expect(JSON.parse(delivery.body)).toMatchObject({
      type: 'execution.failed',
      data: { error: expect.stringContaining('lease expired') },
    });
  });

  it('does not accept a notification signed with the outbound secret as an incoming webhook', async () => {
    const execution = await execute(tenant, [{ id: 'note', type: 'log', message: 'hi' }]);
    const delivery = await deliveredOnce(execution.id);
    const target = await api()
      .post('/workflows')
      .set('x-api-key', tenant.apiKey)
      .send({ name: 'reflected', steps: [{ id: 'note', type: 'log', message: 'x' }] })
      .expect(201);

    const reflected = await api()
      .post(`/hooks/${target.body.id}`)
      .set('content-type', 'application/json')
      .set('webhook-id', String(delivery.headers['webhook-id']))
      .set('webhook-timestamp', String(delivery.headers['webhook-timestamp']))
      .set('webhook-signature', String(delivery.headers['webhook-signature']))
      .send(delivery.body);

    expect(reflected.status).toBe(401);
  });

  it('signs with every active secret while the previous one is in its grace period', async () => {
    const rotated = await api().post('/notifications/secrets').set('x-api-key', tenant.apiKey).expect(201);

    const execution = await execute(tenant, [{ id: 'note', type: 'log', message: 'hi' }]);
    const delivery = await deliveredOnce(execution.id);

    expect(String(delivery.headers['webhook-signature']).split(' ')).toHaveLength(2);
    expect(verify(delivery, [secret])).toBeDefined();
    expect(verify(delivery, [rotated.body.secret])).toBeDefined();
  });
});

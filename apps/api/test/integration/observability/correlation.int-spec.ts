import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Execution } from '../../../src/entities';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant } from '../../support/db';
import { eventually } from '../../support/eventually';
import { Receiver, startReceiver } from '../../support/receiver';
import { spawnWorkerProcess, WorkerProcess } from '../../support/worker';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('one correlation id from the request to the outgoing calls', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let receiver: Receiver;
  let worker: WorkerProcess;
  let tenant: SeededTenant;
  let workflowId: string;

  const api = () => request(app.getHttpServer());

  function logLines(): Array<Record<string, unknown>> {
    return worker
      .output()
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));
  }

  beforeAll(async () => {
    app = await createTestApp();
    receiver = await startReceiver();
    tenant = await seedTenant(ctx.ds, 'correlated');
    await api().put('/notifications/endpoint').set('x-api-key', tenant.apiKey).send({ url: `${receiver.url}/notify` }).expect(200);
    const created = await api()
      .post('/workflows')
      .set('x-api-key', tenant.apiKey)
      .send({
        name: 'correlated',
        steps: [
          { id: 'note', type: 'log', message: 'processing {{ input.order }}' },
          { id: 'call', type: 'http', method: 'POST', url: `${receiver.url}/step`, headers: { 'X-Correlation-Id': 'forged' } },
        ],
      })
      .expect(201);
    workflowId = created.body.id;
    worker = spawnWorkerProcess({ DATABASE_URL: ctx.db.url, WORKER_CONCURRENCY: '1', LOG_LEVEL: 'info' });
  });

  afterAll(async () => {
    await worker?.kill('SIGKILL');
    await app?.close();
    await receiver?.close();
  });

  it('carries the request id through the execution, its steps, the outgoing call and the notification', async () => {
    const run = await api()
      .post(`/workflows/${workflowId}/run`)
      .set('x-api-key', tenant.apiKey)
      .set('x-request-id', 'trace-abc-123')
      .send({ order: 7 })
      .expect(201);

    expect(run.headers['x-request-id']).toBe('trace-abc-123');
    expect(await ctx.ds.getRepository(Execution).findOneByOrFail({ id: run.body.id })).toMatchObject({ correlationId: 'trace-abc-123' });

    const [step, notification] = await eventually(
      () => {
        const found = ['/step', '/notify'].map((path) => receiver.requests.find((r) => r.path === path));
        expect(found.every(Boolean)).toBe(true);
        return found;
      },
      { timeoutMs: 20_000 },
    );
    expect(step?.headers['x-correlation-id']).toBe('trace-abc-123');
    expect(notification?.headers['x-correlation-id']).toBe('trace-abc-123');

    await eventually(() =>
      expect(logLines()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            service: 'worker',
            msg: 'processing 7',
            correlationId: 'trace-abc-123',
            executionId: run.body.id,
            tenantId: tenant.tenant.id,
            jobId: expect.any(String),
            stepId: 'note',
          }),
          expect.objectContaining({ msg: 'execution succeeded', correlationId: 'trace-abc-123', executionId: run.body.id }),
          expect.objectContaining({ msg: 'notification delivered', correlationId: 'trace-abc-123', eventId: expect.any(String) }),
        ]),
      ),
    );
  });

  it('replaces a malformed request id with a generated one', async () => {
    const run = await api()
      .post(`/workflows/${workflowId}/run`)
      .set('x-api-key', tenant.apiKey)
      .set('x-request-id', 'bad id with spacesé')
      .send({})
      .expect(201);

    expect(run.headers['x-request-id']).toMatch(UUID);
    expect(await ctx.ds.getRepository(Execution).findOneByOrFail({ id: run.body.id })).toMatchObject({
      correlationId: run.headers['x-request-id'],
    });
  });

  it('answers every request, including a rejected one, with its request id', async () => {
    const rejected = await api().get('/executions').set('x-request-id', 'unauthenticated-1');

    expect(rejected.status).toBe(401);
    expect(rejected.headers['x-request-id']).toBe('unauthenticated-1');
  });

  it('does not write the api key into the worker logs', () => {
    expect(worker.output()).not.toContain(tenant.apiKey);
  });
});

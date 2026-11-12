import { INestApplication } from '@nestjs/common';
import { AddressInfo } from 'net';
import { Client } from 'pg';
import request from 'supertest';
import { Execution } from '../../../src/entities';
import { EXECUTION_EVENTS_CHANNEL } from '../../../src/migrations/1794320900000-execution-change-notifications';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant } from '../../support/db';
import { eventually } from '../../support/eventually';
import { openEventStream } from '../../support/sse';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

describe('change notifications of executions', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let tenant: SeededTenant;
  let listener: Client;
  let workers: InProcessWorkers | undefined;
  const notified: string[] = [];

  async function createRun(steps: unknown[]): Promise<string> {
    const workflow = await request(app.getHttpServer()).post('/workflows').set('x-api-key', tenant.apiKey).send({ name: 'notified', steps }).expect(201);
    const run = await request(app.getHttpServer()).post(`/workflows/${workflow.body.id}/run`).set('x-api-key', tenant.apiKey).send({}).expect(201);
    return run.body.id;
  }

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0, '127.0.0.1');
    tenant = await seedTenant(ctx.ds, 'notifications');
    listener = new Client({ connectionString: ctx.db.adminUrl });
    listener.on('error', () => undefined);
    await listener.connect();
    ctx.onTeardown(() => listener.end());
    listener.on('notification', (message) => notified.push(message.payload ?? ''));
    await listener.query(`LISTEN ${EXECUTION_EVENTS_CHANNEL}`);
  });

  afterEach(async () => {
    await workers?.stop();
    workers = undefined;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('are not sent for an execution that nobody follows', async () => {
    const id = await createRun([
      { id: 'first', type: 'log', message: 'one' },
      { id: 'second', type: 'log', message: 'two' },
    ]);
    workers = await startInProcessWorkers(1);

    await eventually(async () => expect(await ctx.ds.getRepository(Execution).findOneByOrFail({ id })).toMatchObject({ status: 'succeeded' }));
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(notified.filter((payload) => payload === id)).toEqual([]);
  });

  it('are sent while a stream follows the execution', async () => {
    const id = await createRun([
      { id: 'first', type: 'log', message: 'one' },
      { id: 'second', type: 'log', message: 'two' },
    ]);
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const events = await openEventStream(`http://127.0.0.1:${port}/executions/${id}/events`, { 'x-api-key': tenant.apiKey });
    workers = await startInProcessWorkers(1);

    await events.ended;

    expect(notified.filter((payload) => payload === id).length).toBeGreaterThan(0);
    expect(JSON.parse(events.events[events.events.length - 1].data).status).toBe('succeeded');
  });
});

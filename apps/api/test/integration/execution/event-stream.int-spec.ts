import { INestApplication } from '@nestjs/common';
import { request as httpRequest } from 'http';
import { AddressInfo } from 'net';
import request from 'supertest';
import { ExecutionEventsHub } from '../../../src/executions/execution-events.hub';
import { Execution } from '../../../src/entities';
import { ExecutionsService } from '../../../src/executions/executions.service';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant } from '../../support/db';
import { eventually } from '../../support/eventually';
import { EventStream, openEventStream } from '../../support/sse';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

describe('execution event stream', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let baseUrl: string;
  let workers: InProcessWorkers | undefined;
  let tenant: SeededTenant;
  const opened: EventStream[] = [];
  const saved = process.env.EXECUTION_STREAMS_PER_TENANT;

  const statusesOf = (stream: EventStream) => stream.events.filter((e) => e.event === 'snapshot').map((e) => JSON.parse(e.data).status);
  const stream = async (id: string, apiKey = tenant.apiKey) => {
    const opening = await openEventStream(`${baseUrl}/executions/${id}/events`, { 'x-api-key': apiKey });
    opened.push(opening);
    return opening;
  };

  async function createRun(steps: unknown[]): Promise<string> {
    const workflow = await request(app.getHttpServer())
      .post('/workflows')
      .set('x-api-key', tenant.apiKey)
      .send({ name: 'streamed', steps })
      .expect(201);
    const run = await request(app.getHttpServer()).post(`/workflows/${workflow.body.id}/run`).set('x-api-key', tenant.apiKey).send({}).expect(201);
    return run.body.id;
  }

  beforeAll(async () => {
    process.env.EXECUTION_STREAMS_PER_TENANT = '3';
    app = await createTestApp();
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    tenant = await seedTenant(ctx.ds, 'streamed');
  });

  afterEach(async () => {
    for (const s of opened.splice(0)) s.close();
    await workers?.stop();
    workers = undefined;
  });

  afterAll(async () => {
    await app?.close();
    if (saved === undefined) delete process.env.EXECUTION_STREAMS_PER_TENANT;
    else process.env.EXECUTION_STREAMS_PER_TENANT = saved;
  });

  it('ends open streams when the API shuts down so that it can stop', async () => {
    const id = await createRun([{ id: 'pause', type: 'delay', ms: 60_000 }]);
    const stopping = await createTestApp();
    await stopping.listen(0, '127.0.0.1');
    const port = (stopping.getHttpServer().address() as AddressInfo).port;
    const events = await openEventStream(`http://127.0.0.1:${port}/executions/${id}/events`, { 'x-api-key': tenant.apiKey });
    opened.push(events);
    expect(events.status).toBe(200);

    const closed = stopping.close().then(() => 'closed' as const);
    const stuck = new Promise<'stuck'>((resolve) => setTimeout(() => resolve('stuck'), 5_000).unref());

    expect(await Promise.race([closed, stuck])).toBe('closed');
    await events.ended;
  });

  describe('when reading a snapshot fails', () => {
    afterEach(() => jest.restoreAllMocks());

    const finish = (id: string) => ctx.ds.getRepository(Execution).update(id, { status: 'succeeded', finishedAt: new Date() });

    it('retries the read and still delivers the final status', async () => {
      const id = await createRun([{ id: 'pause', type: 'delay', ms: 60_000 }]);
      const events = await stream(id);
      await eventually(() => expect(statusesOf(events).length).toBeGreaterThan(0));
      jest.spyOn(app.get(ExecutionsService), 'get').mockRejectedValueOnce(new Error('canceling statement due to statement timeout'));

      await finish(id);

      await eventually(() => expect(statusesOf(events).at(-1)).toBe('succeeded'), { timeoutMs: 5_000 });
      await events.ended;
    });

    it('ends the stream after repeated failures so that the client reconnects', async () => {
      const id = await createRun([{ id: 'pause', type: 'delay', ms: 60_000 }]);
      const events = await stream(id);
      await eventually(() => expect(statusesOf(events).length).toBeGreaterThan(0));
      jest.spyOn(app.get(ExecutionsService), 'get').mockRejectedValue(new Error('timeout exceeded when trying to connect'));

      await ctx.ds.getRepository(Execution).update(id, { error: 'changed' });

      const outcome = await Promise.race([events.ended.then(() => 'ended'), new Promise((resolve) => setTimeout(() => resolve('open'), 5_000))]);
      expect(outcome).toBe('ended');
    });
  });

  it('sends a change that arrives during the first read only after the event stream headers', async () => {
    const id = await createRun([{ id: 'pause', type: 'delay', ms: 60_000 }]);
    const service = app.get(ExecutionsService);
    const original = service.get.bind(service);
    jest.spyOn(service, 'get').mockImplementationOnce(async (tenantId, executionId) => {
      await ctx.ds.getRepository(Execution).update(executionId, { error: 'changed while loading' });
      await new Promise((resolve) => setTimeout(resolve, 400));
      return original(tenantId, executionId);
    });

    try {
      const events = await stream(id);

      expect(events.status).toBe(200);
      expect(events.headers['content-type']).toBe('text/event-stream');
      await eventually(() => expect(events.events.filter((e) => e.event === 'snapshot').length).toBeGreaterThanOrEqual(2));
      expect(events.body.startsWith('retry: ')).toBe(true);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('sends a snapshot on every change and closes the stream when the execution finishes', async () => {
    const id = await createRun([
      { id: 'first', type: 'log', message: 'one' },
      { id: 'pause', type: 'delay', ms: 300 },
      { id: 'second', type: 'log', message: 'two' },
    ]);
    const events = await stream(id);
    expect(events.status).toBe(200);
    workers = await startInProcessWorkers(1);

    await events.ended;

    const statuses = statusesOf(events);
    expect(statuses[0]).toBe('pending');
    expect(statuses).toContain('waiting');
    expect(statuses[statuses.length - 1]).toBe('succeeded');
    const last = JSON.parse(events.events[events.events.length - 1].data);
    expect(last.steps.map((s: { stepId: string; status: string }) => `${s.stepId}:${s.status}`)).toEqual([
      'first:succeeded',
      'pause:succeeded',
      'second:succeeded',
    ]);
  });

  it('sends one final snapshot and closes at once for a finished execution', async () => {
    const id = await createRun([{ id: 'only', type: 'log', message: 'x' }]);
    workers = await startInProcessWorkers(1);
    await eventually(async () => {
      const res = await request(app.getHttpServer()).get(`/executions/${id}`).set('x-api-key', tenant.apiKey);
      expect(res.body.status).toBe('succeeded');
    });

    const events = await stream(id);
    await events.ended;

    expect(statusesOf(events)).toEqual(['succeeded']);
  });

  it('answers 404 for an execution of another tenant and 401 without a key', async () => {
    const id = await createRun([{ id: 'only', type: 'log', message: 'x' }]);
    const other = await seedTenant(ctx.ds, 'stranger');

    const foreign = await stream(id, other.apiKey);
    const anonymous = await stream(id, '');
    await Promise.all([foreign.ended, anonymous.ended]);

    expect(foreign.status).toBe(404);
    expect(foreign.events).toEqual([]);
    expect(anonymous.status).toBe(401);
  });

  it('removes its listener when the client goes away', async () => {
    const hub = app.get(ExecutionEventsHub);
    const id = await createRun([{ id: 'only', type: 'log', message: 'x' }]);
    const before = hub.subscriberCount;

    const events = await stream(id);
    await eventually(() => expect(hub.subscriberCount).toBe(before + 1));
    events.close();

    await eventually(() => expect(hub.subscriberCount).toBe(before));
  });

  it('frees the slot and the listener of a client that leaves before the first snapshot', async () => {
    const hub = app.get(ExecutionEventsHub);
    const executions = app.get(ExecutionsService);
    const id = await createRun([{ id: 'only', type: 'log', message: 'x' }]);
    const before = hub.subscriberCount;
    let releaseFirstRead: () => void = () => undefined;
    const firstReadHeld = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    let firstReadStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      firstReadStarted = resolve;
    });
    const read = executions.get.bind(executions);
    const spy = jest.spyOn(executions, 'get').mockImplementationOnce(async (...args) => {
      firstReadStarted();
      await firstReadHeld;
      return read(...args);
    });

    try {
      const client = httpRequest(`${baseUrl}/executions/${id}/events`, { headers: { 'x-api-key': tenant.apiKey } });
      client.on('error', () => undefined);
      client.end();
      await started;
      await eventually(() => expect(hub.subscriberCount).toBe(before + 1));
      client.destroy();
      await new Promise((resolve) => setTimeout(resolve, 200));
      releaseFirstRead();

      await eventually(() => expect(hub.subscriberCount).toBe(before));
    } finally {
      releaseFirstRead();
      spy.mockRestore();
    }
    const open = await Promise.all([stream(id), stream(id), stream(id)]);
    expect(open.map((s) => s.status)).toEqual([200, 200, 200]);
  });

  it('keeps the stream limit when many streams open at the same moment', async () => {
    const id = await createRun([{ id: 'only', type: 'log', message: 'x' }]);

    const burst = await Promise.all(Array.from({ length: 8 }, () => stream(id)));

    expect(burst.filter((s) => s.status === 200)).toHaveLength(3);
    expect(burst.filter((s) => s.status === 429)).toHaveLength(5);
  });

  it('frees the slot of a stream that was refused with 404', async () => {
    const other = await seedTenant(ctx.ds, 'missing-target');
    for (let i = 0; i < 5; i++) {
      const missing = await stream('00000000-0000-0000-0000-000000000000', other.apiKey);
      expect(missing.status).toBe(404);
    }
    const id = await request(app.getHttpServer())
      .post('/workflows')
      .set('x-api-key', other.apiKey)
      .send({ name: 'x', steps: [{ id: 'only', type: 'log', message: 'x' }] })
      .expect(201);
    const run = await request(app.getHttpServer()).post(`/workflows/${id.body.id}/run`).set('x-api-key', other.apiKey).send({}).expect(201);

    expect((await stream(run.body.id, other.apiKey)).status).toBe(200);
  });

  it('limits the number of open streams per tenant', async () => {
    const id = await createRun([{ id: 'only', type: 'log', message: 'x' }]);
    const open = await Promise.all([stream(id), stream(id), stream(id)]);
    expect(open.map((s) => s.status)).toEqual([200, 200, 200]);

    const refused = await stream(id);
    await refused.ended;
    expect(refused.status).toBe(429);

    open[0].close();
    await eventually(async () => {
      const again = await stream(id);
      expect(again.status).toBe(200);
    });
  });
});

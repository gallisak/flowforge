import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Execution, Job } from '../../../src/entities';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { Receiver, startReceiver } from '../../support/receiver';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

describe('F-26 a NUL character cannot break storing data', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let receiver: Receiver;
  let workers: InProcessWorkers;
  let tenant: SeededTenant;
  const saved = { base: process.env.RETRY_BASE_MS, cap: process.env.RETRY_CAP_MS };

  async function finished(steps: Parameters<typeof seedWorkflow>[2]): Promise<Execution> {
    const workflow = await seedWorkflow(ctx.ds, tenant.tenant.id, steps);
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.tenant.id, workflowId: workflow.id, input: {} });
    await ctx.ds.getRepository(Job).save({ tenantId: tenant.tenant.id, executionId: execution.id });
    return eventually(async () => {
      const current = await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id });
      expect(['succeeded', 'failed']).toContain(current.status);
      return current;
    });
  }

  beforeAll(async () => {
    process.env.RETRY_BASE_MS = '50';
    process.env.RETRY_CAP_MS = '100';
    app = await createTestApp();
    tenant = await seedTenant(ctx.ds, 'nul-characters');
    receiver = await startReceiver((req, res) => {
      if (req.path === '/json') res.writeHead(200, { 'content-type': 'application/json' }).end('{"name":"a\\u0000b"}');
      else res.writeHead(200, { 'content-type': 'text/plain' }).end('a\u0000b');
    });
    workers = await startInProcessWorkers(1);
  });

  afterAll(async () => {
    await workers?.stop();
    await app?.close();
    await receiver?.close();
    for (const [name, value] of [
      ['RETRY_BASE_MS', saved.base],
      ['RETRY_CAP_MS', saved.cap],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('rejects a request body with a NUL character as a client error', async () => {
    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set('x-api-key', tenant.apiKey)
      .send({ name: 'nul', steps: [{ id: 'note', type: 'log', message: 'hi' }] })
      .expect(201);

    const run = await request(app.getHttpServer())
      .post(`/workflows/${created.body.id}/run`)
      .set('x-api-key', tenant.apiKey)
      .send({ value: 'a\u0000b' });

    expect(run.status).toBe(400);
  });

  it('stores a text response that contains a NUL character', async () => {
    const execution = await finished([{ id: 'call', type: 'http', url: `${receiver.url}/text` }]);

    expect(execution).toMatchObject({ status: 'succeeded', output: { status: 200, body: 'a�b' } });
  });

  it('stores a JSON response whose strings contain a NUL character', async () => {
    const execution = await finished([{ id: 'call', type: 'http', url: `${receiver.url}/json` }]);

    expect(execution).toMatchObject({ status: 'succeeded', output: { status: 200, body: { name: 'a�b' } } });
  });

  it('records a step error message that contains a NUL character', async () => {
    const execution = await finished([{ id: 'shape', type: 'transform', expr: '(() => { throw new Error("bad\\u0000value"); })()' }]);

    expect(execution.status).toBe('failed');
    expect(execution.error).toContain('bad�value');
  });
});

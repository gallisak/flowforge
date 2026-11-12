import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Execution, Job } from '../../../src/entities';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { Receiver, startReceiver } from '../../support/receiver';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

describe('a lone UTF-16 surrogate cannot break storing data', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let receiver: Receiver;
  let workers: InProcessWorkers;
  let tenant: SeededTenant;

  async function finished(steps: Parameters<typeof seedWorkflow>[2]): Promise<{ execution: Execution; job: Job }> {
    const workflow = await seedWorkflow(ctx.ds, tenant.tenant.id, steps);
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.tenant.id, workflowId: workflow.id, input: {} });
    const job = await ctx.ds.getRepository(Job).save({ tenantId: tenant.tenant.id, executionId: execution.id });
    return eventually(async () => {
      const current = await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id });
      expect(['succeeded', 'failed']).toContain(current.status);
      return { execution: current, job: await ctx.ds.getRepository(Job).findOneByOrFail({ id: job.id }) };
    });
  }

  beforeAll(async () => {
    app = await createTestApp();
    tenant = await seedTenant(ctx.ds, 'lone-surrogates');
    receiver = await startReceiver((req, res) => {
      if (req.path === '/json') res.writeHead(200, { 'content-type': 'application/json' }).end('{"name":"a\\ud800b"}');
      else res.writeHead(200, { 'content-type': 'text/plain' }).end(`${'x'.repeat(9_999)}\u{1F600}tail`);
    });
    workers = await startInProcessWorkers(1);
  });

  afterAll(async () => {
    await workers?.stop();
    await app?.close();
    await receiver?.close();
  });

  it('rejects request bodies with a lone surrogate as a client error', async () => {
    const workflow = await request(app.getHttpServer())
      .post('/workflows')
      .set('x-api-key', tenant.apiKey)
      .set('content-type', 'application/json')
      .send('{"name":"surrogate","steps":[{"id":"note","type":"log","message":"x\\ud800"}]}');
    expect(workflow.status).toBe(400);

    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set('x-api-key', tenant.apiKey)
      .send({ name: 'surrogate', steps: [{ id: 'note', type: 'log', message: 'hi' }] })
      .expect(201);
    const run = await request(app.getHttpServer())
      .post(`/workflows/${created.body.id}/run`)
      .set('x-api-key', tenant.apiKey)
      .set('content-type', 'application/json')
      .send('{"value":"\\udfff"}');
    expect(run.status).toBe(400);
  });

  it('stores a transform output with a lone surrogate in one attempt', async () => {
    const { execution, job } = await finished([{ id: 'shape', type: 'transform', expr: '({ half: "\\u{1F600}".slice(0, 1) })' }]);

    expect(execution).toMatchObject({ status: 'succeeded', output: { half: '�' } });
    expect(job.attempts).toBe(1);
  });

  it('stores a JSON response with a lone surrogate', async () => {
    const { execution } = await finished([{ id: 'call', type: 'http', url: `${receiver.url}/json` }]);

    expect(execution).toMatchObject({ status: 'succeeded', output: { status: 200, body: { name: 'a�b' } } });
  });

  it('cuts a long text response without splitting a character', async () => {
    const { execution } = await finished([{ id: 'call', type: 'http', url: `${receiver.url}/text` }]);

    expect(execution.status).toBe('succeeded');
    expect((execution.output as { body: string }).body).toBe('x'.repeat(9_999));
  });
});

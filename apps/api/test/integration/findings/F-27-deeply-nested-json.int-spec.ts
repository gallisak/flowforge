import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Execution, Job } from '../../../src/entities';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { Receiver, startReceiver } from '../../support/receiver';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

const nested = (depth: number) => `${'['.repeat(depth)}${']'.repeat(depth)}`;

describe('F-27 deeply nested JSON is rejected instead of crashing', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let receiver: Receiver;
  let workers: InProcessWorkers;
  let tenant: SeededTenant;
  const saved = { base: process.env.RETRY_BASE_MS, cap: process.env.RETRY_CAP_MS };

  async function finished(url: string): Promise<{ execution: Execution; job: Job }> {
    const workflow = await seedWorkflow(ctx.ds, tenant.tenant.id, [{ id: 'call', type: 'http', url }]);
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.tenant.id, workflowId: workflow.id, input: {} });
    const job = await ctx.ds.getRepository(Job).save({ tenantId: tenant.tenant.id, executionId: execution.id });
    return eventually(async () => {
      const current = await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id });
      expect(['succeeded', 'failed']).toContain(current.status);
      return { execution: current, job: await ctx.ds.getRepository(Job).findOneByOrFail({ id: job.id }) };
    });
  }

  beforeAll(async () => {
    process.env.RETRY_BASE_MS = '50';
    process.env.RETRY_CAP_MS = '100';
    app = await createTestApp();
    tenant = await seedTenant(ctx.ds, 'deep-json');
    receiver = await startReceiver((req, res) => {
      const depth = Number(req.path.split('/')[2]);
      res.writeHead(200, { 'content-type': 'application/json' }).end(`{"data":${nested(depth)}}`);
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

  it('answers a deeply nested request body with a clear client error', async () => {
    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set('x-api-key', tenant.apiKey)
      .send({ name: 'deep', steps: [{ id: 'note', type: 'log', message: 'hi' }] })
      .expect(201);

    const run = await request(app.getHttpServer())
      .post(`/workflows/${created.body.id}/run`)
      .set('x-api-key', tenant.apiKey)
      .set('content-type', 'application/json')
      .send(`{"value":${nested(20_000)}}`);

    expect(run.status).toBe(400);
    expect(run.body.message).toMatch(/nested deeper than/);
  });

  it('fails a step on a deeply nested response without retrying it', async () => {
    const { execution, job } = await finished(`${receiver.url}/depth/50000`);

    expect(execution.status).toBe('failed');
    expect(execution.error).toMatch(/nested deeper than/);
    expect(job.attempts).toBe(1);
  });

  it('accepts a response with ordinary nesting', async () => {
    const { execution } = await finished(`${receiver.url}/depth/20`);

    expect(execution.status).toBe('succeeded');
  });
});

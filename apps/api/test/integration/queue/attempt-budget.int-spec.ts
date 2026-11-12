import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import { Execution, Job } from '../../../src/entities';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { Receiver, startReceiver } from '../../support/receiver';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

describe('attempt budget of a job', () => {
  const ctx = useIntegrationContext();
  let receiver: Receiver;
  let workers: InProcessWorkers | undefined;
  const failedOnce = new Set<string>();
  const names = ['RETRY_BASE_MS', 'RETRY_CAP_MS', 'JOB_MAX_ATTEMPTS'] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));

  beforeAll(async () => {
    process.env.RETRY_BASE_MS = '50';
    process.env.RETRY_CAP_MS = '100';
    receiver = await startReceiver((req, res) => {
      if (!failedOnce.has(req.path)) {
        failedOnce.add(req.path);
        res.writeHead(503).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });

  afterEach(async () => {
    await workers?.stop();
    workers = undefined;
  });

  afterAll(async () => {
    await receiver?.close();
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it('gives every step its own attempts, so that progress is not lost to earlier failures', async () => {
    const { tenant } = await seedTenant(ctx.ds, 'per-step-attempts');
    const workflow = await seedWorkflow(
      ctx.ds,
      tenant.id,
      ['a', 'b', 'c'].map((id) => ({ id, type: 'http' as const, url: `${receiver.url}/${id}` })),
    );
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.id, workflowId: workflow.id, input: {} });
    await ctx.ds.getRepository(Job).save({ tenantId: tenant.id, executionId: execution.id, maxAttempts: 2 });
    workers = await startInProcessWorkers(1);

    const finished = await eventually(async () => {
      const current = await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id });
      expect(['succeeded', 'failed']).toContain(current.status);
      return current;
    });

    expect(finished).toMatchObject({ status: 'succeeded', error: null });
  });

  it('takes the number of attempts of new jobs from the configuration', async () => {
    process.env.JOB_MAX_ATTEMPTS = '7';
    const app: INestApplication = await createTestApp();
    try {
      const tenant: SeededTenant = await seedTenant(ctx.ds, 'configured-attempts');
      const workflow = await seedWorkflow(ctx.ds, tenant.tenant.id, [{ id: 'note', type: 'log', message: 'hi' }]);
      const run = await request(app.getHttpServer()).post(`/workflows/${workflow.id}/run`).set('x-api-key', tenant.apiKey).send({}).expect(201);

      expect(await ctx.ds.getRepository(Job).findOneByOrFail({ executionId: run.body.id })).toMatchObject({ maxAttempts: 7 });
    } finally {
      await app.close();
      delete process.env.JOB_MAX_ATTEMPTS;
    }
  });

  it('defaults to enough attempts to ride out a short outage', async () => {
    const app: INestApplication = await createTestApp();
    try {
      const tenant: SeededTenant = await seedTenant(ctx.ds, 'default-attempts');
      const workflow = await seedWorkflow(ctx.ds, tenant.tenant.id, [{ id: 'note', type: 'log', message: 'hi' }]);
      const run = await request(app.getHttpServer()).post(`/workflows/${workflow.id}/run`).set('x-api-key', tenant.apiKey).send({}).expect(201);

      expect(await ctx.ds.getRepository(Job).findOneByOrFail({ executionId: run.body.id })).toMatchObject({ maxAttempts: 8 });
    } finally {
      await app.close();
    }
  });

  it('waits with backoff before running a job again after its lease expired', async () => {
    const { tenant } = await seedTenant(ctx.ds, 'reaper-backoff');
    const workflow = await seedWorkflow(ctx.ds, tenant.id, [{ id: 'note', type: 'log', message: 'hi' }]);
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.id, workflowId: workflow.id, input: {}, status: 'running' });
    const job = await ctx.ds.getRepository(Job).save({
      tenantId: tenant.id,
      executionId: execution.id,
      status: 'running',
      attempts: 2,
      maxAttempts: 8,
      lockedBy: 'worker-that-died',
      lockedUntil: new Date(Date.now() - 60_000),
    });
    const app = new Client({ connectionString: ctx.db.url });
    await app.connect();
    try {
      await app.query('SELECT * FROM reap_expired_jobs(1000, 300000)');
    } finally {
      await app.end();
    }

    const [{ delayMs }]: Array<{ delayMs: number }> = await ctx.ds.query(
      `SELECT EXTRACT(EPOCH FROM ("runAt" - now())) * 1000 AS "delayMs" FROM jobs WHERE id = $1 AND status = 'queued'`,
      [job.id],
    );
    expect(Number(delayMs)).toBeGreaterThan(500);
  });
});

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Execution, Job } from '../../../src/entities';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { Receiver, startReceiver } from '../../support/receiver';
import { spawnWorkerProcess, startInProcessWorkers } from '../../support/worker';

describe('integration harness', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let receiver: Receiver;

  beforeAll(async () => {
    app = await createTestApp();
    receiver = await startReceiver();
  });

  afterAll(async () => {
    await app?.close();
    await receiver?.close();
  });

  it('gives each test file its own database with the application schema', async () => {
    const [{ db }] = await ctx.ds.query('SELECT current_database() AS db');
    expect(db).toBe(ctx.db.name);
    expect(db).toMatch(/^ff_t_[0-9a-f]{12}$/);

    const tables: Array<{ table_name: string }> = await ctx.ds.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    expect(tables.map((t) => t.table_name)).toEqual(
      expect.arrayContaining(['executions', 'jobs', 'step_runs', 'tenants', 'workflows']),
    );
  });

  it('serves the real HTTP API against the test database', async () => {
    const { apiKey } = await seedTenant(ctx.ds, 'harness-http');

    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set('x-api-key', apiKey)
      .send({ name: 'wf', steps: [{ id: 'hello', type: 'log', message: 'hi' }] })
      .expect(201);

    const list = await request(app.getHttpServer()).get('/workflows').set('x-api-key', apiKey).expect(200);
    expect(list.body.map((w: { id: string }) => w.id)).toEqual([created.body.id]);
  });

  it('runs a workflow end to end with an in-process worker and records outbound requests', async () => {
    const { tenant, apiKey } = await seedTenant(ctx.ds, 'harness-worker');
    const wf = await seedWorkflow(ctx.ds, tenant.id, [
      { id: 'call', type: 'http', url: `${receiver.url}/hook?who={{ input.who }}` },
      { id: 'done', type: 'log', message: 'done' },
    ]);

    const run = await request(app.getHttpServer())
      .post(`/workflows/${wf.id}/run`)
      .set('x-api-key', apiKey)
      .send({ who: 'ada' })
      .expect(201);

    const workers = await startInProcessWorkers(1);
    try {
      await eventually(async () => {
        const e = await ctx.ds.getRepository(Execution).findOneByOrFail({ id: run.body.id });
        expect(e.status).toBe('succeeded');
      });
    } finally {
      await workers.stop();
    }

    const hits = receiver.requests.filter((r) => r.path.startsWith('/hook'));
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe('/hook?who=ada');
  });

  it('spawns a real worker process that can be killed mid-step', async () => {
    const { tenant, apiKey } = await seedTenant(ctx.ds, 'harness-process');
    receiver.setHandler((req, res) => {
      if (req.path === '/hang') return;
      res.writeHead(200).end('{}');
    });
    const wf = await seedWorkflow(ctx.ds, tenant.id, [{ id: 'hang', type: 'http', url: `${receiver.url}/hang` }]);

    const worker = spawnWorkerProcess({ DATABASE_URL: ctx.db.url, WORKER_CONCURRENCY: '1' });
    try {
      await worker.waitForOutput(/started, concurrency=1/);
      const run = await request(app.getHttpServer()).post(`/workflows/${wf.id}/run`).set('x-api-key', apiKey).expect(201);

      await eventually(() => expect(receiver.requests.some((r) => r.path === '/hang')).toBe(true));
      const job = await ctx.ds.getRepository(Job).findOneByOrFail({ executionId: run.body.id });
      expect(job.status).toBe('running');
    } finally {
      const exit = await worker.kill('SIGKILL');
      expect(exit.signal).toBe('SIGKILL');
    }
  });
});

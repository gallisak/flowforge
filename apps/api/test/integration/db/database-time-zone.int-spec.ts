import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../../../src/db/data-source';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant } from '../../support/db';
import { eventually } from '../../support/eventually';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

const FAR_FROM_UTC = 'Pacific/Kiritimati';
const CLOCK_TOLERANCE_MS = 60_000;

describe('timestamps when the database session time zone is not UTC', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let workers: InProcessWorkers;
  let tenant: SeededTenant;

  const api = () => request(app.getHttpServer());
  const expectNow = (value: string) => expect(Math.abs(new Date(value).getTime() - Date.now())).toBeLessThan(CLOCK_TOLERANCE_MS);

  beforeAll(async () => {
    await ctx.ds.query(`ALTER DATABASE ${ctx.db.name} SET timezone TO '${FAR_FROM_UTC}'`);
    app = await createTestApp();
    workers = await startInProcessWorkers(1);
    tenant = await seedTenant(ctx.ds, 'time-zones');
  });

  afterAll(async () => {
    await workers?.stop();
    await app?.close();
  });

  it('reports creation and step start times as the real instant', async () => {
    const workflow = await api()
      .post('/workflows')
      .set('x-api-key', tenant.apiKey)
      .send({ name: 'clock', steps: [{ id: 'note', type: 'log', message: 'tick' }] })
      .expect(201);
    expectNow(workflow.body.createdAt);

    const run = await api().post(`/workflows/${workflow.body.id}/run`).set('x-api-key', tenant.apiKey).send({}).expect(201);
    expectNow(run.body.createdAt);

    const execution = await eventually(async () => {
      const res = await api().get(`/executions/${run.body.id}`).set('x-api-key', tenant.apiKey).expect(200);
      expect(res.body.status).toBe('succeeded');
      return res.body;
    });
    expectNow(execution.createdAt);
    expectNow(execution.steps[0].startedAt);
    expect(new Date(execution.finishedAt).getTime()).toBeGreaterThanOrEqual(new Date(execution.createdAt).getTime());
  });

  it('pages through executions with the cursor', async () => {
    const workflow = await api()
      .post('/workflows')
      .set('x-api-key', tenant.apiKey)
      .send({ name: 'pages', steps: [{ id: 'note', type: 'log', message: 'tick' }] })
      .expect(201);
    const created: string[] = [];
    for (let i = 0; i < 3; i++) {
      created.push((await api().post(`/workflows/${workflow.body.id}/run`).set('x-api-key', tenant.apiKey).send({}).expect(201)).body.id);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const res = await api()
        .get('/executions')
        .query({ workflowId: workflow.body.id, limit: '1', ...(cursor ? { cursor } : {}) })
        .set('x-api-key', tenant.apiKey)
        .expect(200);
      seen.push(...res.body.map((e: { id: string }) => e.id));
      cursor = res.headers['x-next-cursor'];
    } while (cursor);

    expect(seen).toEqual([...created].reverse());
  });
  it('keeps the instants of rows written before the migration to time zone aware columns', async () => {
    const owner = await new DataSource(dataSourceOptions(ctx.db.ownerUrl)).initialize();
    try {
      const latest = async () => (await owner.query(`SELECT name FROM migrations ORDER BY id DESC LIMIT 1`))[0].name;
      while ((await latest()) !== 'IdleTenantClaims1794322400000') await owner.undoLastMigration({ transaction: 'each' });
      const [{ id }]: Array<{ id: string }> = await owner.query(`INSERT INTO tenants (name, "apiKeyHash") VALUES ('before', 'x') RETURNING id`);

      await owner.runMigrations({ transaction: 'each' });

      const [{ createdAt }]: Array<{ createdAt: Date }> = await owner.query(`SELECT "createdAt" FROM tenants WHERE id = $1`, [id]);
      expect(Math.abs(createdAt.getTime() - Date.now())).toBeLessThan(CLOCK_TOLERANCE_MS);
    } finally {
      await owner.destroy();
    }
  });
});

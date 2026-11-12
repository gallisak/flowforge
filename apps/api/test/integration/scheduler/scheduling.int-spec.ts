import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Execution, Job, Tenant } from '../../../src/entities';
import { metrics } from '../../../src/observability/metrics';
import { createTestApp } from '../../support/app';
import { restoreClock, setClock } from '../../support/clock';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant, seedWorkflow } from '../../support/db';
import { consistently, eventually } from '../../support/eventually';
import { createScheduledWorkflow, InProcessSchedulers, startInProcessSchedulers } from '../../support/scheduler';

describe('distributed scheduler', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let tenant: SeededTenant;
  let schedulers: InProcessSchedulers | undefined;
  const saved = { tick: process.env.SCHEDULER_TICK_MS, catchUp: process.env.SCHEDULER_MAX_CATCH_UP_RUNS };

  const cronRuns = (workflowId: string) =>
    ctx.ds.getRepository(Execution).find({ where: { workflowId, trigger: 'cron' }, order: { createdAt: 'ASC' } });

  async function tickAt(now: string): Promise<void> {
    setClock(now);
    await schedulers?.services[0].tick();
  }

  const update = (workflowId: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).patch(`/workflows/${workflowId}`).set('x-api-key', tenant.apiKey).send(body);

  beforeAll(async () => {
    app = await createTestApp();
    tenant = await seedTenant(ctx.ds, 'scheduling');
  });

  afterEach(async () => {
    await schedulers?.stop();
    schedulers = undefined;
    restoreClock();
    for (const [name, value] of [
      ['SCHEDULER_TICK_MS', saved.tick],
      ['SCHEDULER_MAX_CATCH_UP_RUNS', saved.catchUp],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it('exposes the next run and the missed run policy of a scheduled workflow', async () => {
    setClock('2026-11-20T08:30:00Z');
    const created = await createScheduledWorkflow(app, tenant.apiKey, { cron: '0 9 * * *', timezone: 'Europe/Kyiv' });

    const fetched = await request(app.getHttpServer()).get(`/workflows/${created.id}`).set('x-api-key', tenant.apiKey).expect(200);

    expect(fetched.body).toMatchObject({ nextRunAt: '2026-11-21T07:00:00.000Z', missedRunPolicy: 'once' });
  });

  it('rejects an unknown missed run policy', async () => {
    const response = await request(app.getHttpServer())
      .post('/workflows')
      .set('x-api-key', tenant.apiKey)
      .send({ name: 'bad-policy', steps: [{ id: 'note', type: 'log', message: 'x' }], cron: '0 9 * * *', missedRunPolicy: 'twice' });

    expect(response.status).toBe(400);
  });

  it('recomputes the next run when the cron expression or the time zone changes', async () => {
    setClock('2026-11-20T08:30:00Z');
    const created = await createScheduledWorkflow(app, tenant.apiKey, { cron: '0 9 * * *' });

    const retimed = await update(created.id, { cron: '0 12 * * *' }).expect(200);
    expect(retimed.body.nextRunAt).toBe('2026-11-20T12:00:00.000Z');

    const moved = await update(created.id, { timezone: 'America/New_York' }).expect(200);
    expect(moved.body.nextRunAt).toBe('2026-11-20T17:00:00.000Z');

    const unscheduled = await update(created.id, { cron: null }).expect(200);
    expect(unscheduled.body.nextRunAt).toBeNull();
  });

  it('does not fire a disabled workflow nor catch up on runs from while it was disabled', async () => {
    setClock('2026-11-20T08:30:00Z');
    const created = await createScheduledWorkflow(app, tenant.apiKey, { cron: '0 * * * *', missedRunPolicy: 'all' });
    await update(created.id, { enabled: false }).expect(200);
    schedulers = await startInProcessSchedulers(1);

    await tickAt('2026-11-20T12:00:05Z');
    expect(await cronRuns(created.id)).toHaveLength(0);

    setClock('2026-11-20T12:30:00Z');
    const enabled = await update(created.id, { enabled: true }).expect(200);
    expect(enabled.body.nextRunAt).toBe('2026-11-20T13:00:00.000Z');

    await tickAt('2026-11-20T12:30:10Z');
    expect(await cronRuns(created.id)).toHaveLength(0);

    await tickAt('2026-11-20T13:00:05Z');
    expect(await cronRuns(created.id)).toHaveLength(1);
  });

  it('records the scheduled time of every catch-up run in its input and trigger key', async () => {
    setClock('2026-11-20T08:30:00Z');
    const created = await createScheduledWorkflow(app, tenant.apiKey, { cron: '0 * * * *', missedRunPolicy: 'all' });
    schedulers = await startInProcessSchedulers(1);

    await tickAt('2026-11-20T11:30:00Z');

    const runs = await cronRuns(created.id);
    const expected = ['2026-11-20T09:00:00.000Z', '2026-11-20T10:00:00.000Z', '2026-11-20T11:00:00.000Z'];
    expect(runs.map((run) => run.input).sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)))).toEqual(
      expected.map((scheduledAt) => ({ scheduledAt })),
    );
    expect(runs.map((run) => run.triggerKey).sort()).toEqual(expected.map((scheduledAt) => `cron:${created.id}:${scheduledAt}`));
    expect(await ctx.ds.getRepository(Job).countBy({ executionId: runs[0].id })).toBe(1);
  });

  it('starts only the latest missed runs above the catch-up limit', async () => {
    process.env.SCHEDULER_MAX_CATCH_UP_RUNS = '3';
    setClock('2026-11-20T08:30:00Z');
    const created = await createScheduledWorkflow(app, tenant.apiKey, { cron: '0 * * * *', missedRunPolicy: 'all' });
    schedulers = await startInProcessSchedulers(1);

    await tickAt('2026-11-20T19:30:00Z');

    const scheduledAt = (await cronRuns(created.id)).map((run) => run.input.scheduledAt).sort();
    expect(scheduledAt).toEqual(['2026-11-20T17:00:00.000Z', '2026-11-20T18:00:00.000Z', '2026-11-20T19:00:00.000Z']);
  });

  it('fires once while ticking every few minutes through the spring-forward gap', async () => {
    setClock('2026-03-07T12:00:00Z');
    const created = await createScheduledWorkflow(app, tenant.apiKey, { cron: '30 2 * * *', timezone: 'America/New_York' });
    schedulers = await startInProcessSchedulers(1);

    for (let minute = 55; minute <= 95; minute += 5) {
      const now = new Date(Date.UTC(2026, 2, 8, 6, minute, 5));
      await tickAt(now.toISOString());
    }

    const runs = await cronRuns(created.id);
    expect(runs.map((run) => run.input.scheduledAt)).toEqual(['2026-03-08T07:30:00.000Z']);
  });

  it('keeps firing other workflows when enqueueing one of them fails', async () => {
    setClock('2026-11-20T08:30:00Z');
    const crowded = await seedTenant(ctx.ds, 'crowded-tenant');
    await ctx.ds.getRepository(Tenant).update(crowded.tenant.id, { maxQueuedJobs: 1 });
    const filler = await seedWorkflow(ctx.ds, crowded.tenant.id, [{ id: 'note', type: 'log', message: 'fill' }]);
    const queued = await ctx.ds.getRepository(Execution).save({ tenantId: crowded.tenant.id, workflowId: filler.id, input: {} });
    await ctx.ds.getRepository(Job).save({ tenantId: crowded.tenant.id, executionId: queued.id });
    const blocked = await createScheduledWorkflow(app, crowded.apiKey, { cron: '0 9 * * *', timezone: 'UTC' });
    const healthy = await createScheduledWorkflow(app, tenant.apiKey, { cron: '0 9 * * *', timezone: 'UTC' });
    schedulers = await startInProcessSchedulers(1);

    await tickAt('2026-11-20T09:00:05Z');

    expect(await cronRuns(blocked.id)).toHaveLength(0);
    expect(await cronRuns(healthy.id)).toHaveLength(1);
  });

  it('postpones the schedules of a tenant whose queue is full instead of retrying them on every claim', async () => {
    setClock('2026-11-20T08:30:00Z');
    const crowded = await seedTenant(ctx.ds, 'full-queue');
    await ctx.ds.getRepository(Tenant).update(crowded.tenant.id, { maxQueuedJobs: 1 });
    const filler = await seedWorkflow(ctx.ds, crowded.tenant.id, [{ id: 'note', type: 'log', message: 'fill' }]);
    const queued = await ctx.ds.getRepository(Execution).save({ tenantId: crowded.tenant.id, workflowId: filler.id, input: {} });
    await ctx.ds.getRepository(Job).save({ tenantId: crowded.tenant.id, executionId: queued.id });
    for (let i = 0; i < 30; i++) {
      await seedWorkflow(ctx.ds, crowded.tenant.id, [{ id: 'note', type: 'log', message: 'tick' }], {
        cron: '0 9 * * *',
        nextRunAt: new Date('2026-11-20T09:00:00Z'),
      });
    }
    const healthy = await createScheduledWorkflow(app, tenant.apiKey, { cron: '0 9 * * *', timezone: 'UTC' });
    schedulers = await startInProcessSchedulers(1);
    const postponed = async () => (await metrics.scheduledRuns.get()).values.find((v) => v.labels.outcome === 'postponed')?.value ?? 0;

    await tickAt('2026-11-20T09:00:30Z');
    const afterFirstTick = await postponed();
    await tickAt('2026-11-20T09:00:33Z');

    expect(await postponed()).toBe(afterFirstTick);
    expect(await cronRuns(healthy.id)).toHaveLength(1);
    const waiting: Array<{ retryAt: Date }> = await ctx.ds.query(
      `SELECT "scheduleRetryAt" AS "retryAt" FROM workflows WHERE "tenantId" = $1 AND cron IS NOT NULL`,
      [crowded.tenant.id],
    );
    expect(waiting).toHaveLength(30);
    expect(waiting.every((row) => row.retryAt > new Date('2026-11-20T09:00:33Z'))).toBe(true);
  });

  it('starts the catch-up runs that fit the tenant queue and the rest once the queue drains', async () => {
    setClock('2026-11-20T08:30:00Z');
    const small = await seedTenant(ctx.ds, 'small-queue');
    await ctx.ds.getRepository(Tenant).update(small.tenant.id, { maxQueuedJobs: 2 });
    const created = await createScheduledWorkflow(app, small.apiKey, { cron: '0 * * * *', missedRunPolicy: 'all' });
    schedulers = await startInProcessSchedulers(1);
    const drainQueue = () => ctx.ds.getRepository(Job).update({ tenantId: small.tenant.id }, { status: 'done' });

    await tickAt('2026-11-20T13:30:00Z');
    expect(await cronRuns(created.id)).toHaveLength(2);

    await drainQueue();
    await tickAt('2026-11-20T13:30:10Z');
    expect(await cronRuns(created.id)).toHaveLength(4);

    await drainQueue();
    await tickAt('2026-11-20T13:30:20Z');
    const scheduledAt = (await cronRuns(created.id)).map((run) => run.input.scheduledAt).sort();
    expect(scheduledAt).toEqual(['09', '10', '11', '12', '13'].map((hour) => `2026-11-20T${hour}:00:00.000Z`));
  });

  it('lets another instance skip a schedule that is being fired instead of waiting for it', async () => {
    setClock('2026-11-20T08:30:00Z');
    const created = await createScheduledWorkflow(app, tenant.apiKey, { cron: '0 9 * * *', timezone: 'UTC' });
    schedulers = await startInProcessSchedulers(2);
    const blocker = ctx.ds.createQueryRunner();
    await blocker.connect();
    await blocker.startTransaction();
    await blocker.query('LOCK TABLE "jobs" IN SHARE ROW EXCLUSIVE MODE');

    setClock('2026-11-20T09:00:05Z');
    const firing = schedulers.services[0].tick();
    await eventually(async () => {
      const [{ waiting }]: Array<{ waiting: number }> = await ctx.ds.query(
        `SELECT count(*)::int AS waiting FROM pg_locks
          WHERE NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      );
      expect(waiting).toBe(1);
    });
    const skipped = await schedulers.services[1].tick();

    await blocker.rollbackTransaction();
    await blocker.release();
    expect(skipped).toBe(0);
    expect(await firing).toBe(1);
    expect(await cronRuns(created.id)).toHaveLength(1);
  });

  it('does not start a second run for an occurrence that already has one', async () => {
    setClock('2026-11-20T08:30:00Z');
    const created = await createScheduledWorkflow(app, tenant.apiKey, { cron: '0 9 * * *', timezone: 'UTC' });
    schedulers = await startInProcessSchedulers(1);
    await tickAt('2026-11-20T09:00:05Z');

    await ctx.ds.query(`UPDATE "workflows" SET "nextRunAt" = '2026-11-20T09:00:00Z' WHERE "id" = $1`, [created.id]);
    await tickAt('2026-11-20T09:00:10Z');

    expect(await cronRuns(created.id)).toHaveLength(1);
  });

  it('fires an occurrence once when two instances tick on their own timers', async () => {
    process.env.SCHEDULER_TICK_MS = '1000';
    setClock('2026-11-22T08:59:57Z');
    const created = await createScheduledWorkflow(app, tenant.apiKey, { cron: '0 9 * * *', timezone: 'UTC' });

    schedulers = await startInProcessSchedulers(2);

    await eventually(async () => expect(await cronRuns(created.id)).toHaveLength(1), { timeoutMs: 10_000 });
    await consistently(async () => expect(await cronRuns(created.id)).toHaveLength(1), { timeoutMs: 3_000 });
  });
});

import { INestApplication, Logger } from '@nestjs/common';
import { TenantDb } from '../../../src/db/tenant-db.service';
import { Execution, Workflow } from '../../../src/entities';
import { ExecutionsService } from '../../../src/executions/executions.service';
import { currentCorrelationId } from '../../../src/observability/log-context';
import { metrics } from '../../../src/observability/metrics';
import { createTestApp } from '../../support/app';
import { restoreClock, setClock } from '../../support/clock';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant } from '../../support/db';
import { createScheduledWorkflow, InProcessSchedulers, startInProcessSchedulers } from '../../support/scheduler';

interface SchedulerInternals {
  executions: ExecutionsService;
  db: TenantDb;
}

describe('scheduler bookkeeping', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let tenant: SeededTenant;
  let schedulers: InProcessSchedulers | undefined;

  const cronRuns = (workflowId: string) => ctx.ds.getRepository(Execution).find({ where: { workflowId, trigger: 'cron' } });
  const internals = () => schedulers?.services[0] as unknown as SchedulerInternals;

  async function startedRuns(): Promise<number> {
    const { values } = await metrics.scheduledRuns.get();
    return values.filter((value) => value.labels.outcome === 'started').reduce((sum, value) => sum + value.value, 0);
  }

  async function tickAt(now: string): Promise<void> {
    setClock(now);
    await schedulers?.services[0].tick();
  }

  beforeAll(async () => {
    app = await createTestApp();
    tenant = await seedTenant(ctx.ds, 'scheduler-bookkeeping');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await schedulers?.stop();
    schedulers = undefined;
    restoreClock();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('does not count an occurrence that already has a run as started', async () => {
    setClock('2026-11-20T08:30:00Z');
    const created = await createScheduledWorkflow(app, tenant.apiKey, { cron: '0 9 * * *', timezone: 'UTC' });
    schedulers = await startInProcessSchedulers(1);
    await tickAt('2026-11-20T09:00:05Z');
    await ctx.ds.query(`UPDATE "workflows" SET "nextRunAt" = '2026-11-20T09:00:00Z' WHERE "id" = $1`, [created.id]);
    const before = await startedRuns();

    await tickAt('2026-11-20T09:00:10Z');

    expect(await startedRuns()).toBe(before);
    expect(await cronRuns(created.id)).toHaveLength(1);
  });

  it('logs the creation of a scheduled run with the correlation id stored on it', async () => {
    setClock('2026-11-20T08:30:00Z');
    const created = await createScheduledWorkflow(app, tenant.apiKey, { cron: '0 9 * * *', timezone: 'UTC' });
    schedulers = await startInProcessSchedulers(1);
    const logged: Array<string | undefined> = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      if ((message as { msg?: string }).msg === 'execution created') logged.push(currentCorrelationId());
    });

    await tickAt('2026-11-20T09:00:05Z');

    const [run] = await cronRuns(created.id);
    expect(logged).toEqual([run.correlationId]);
  });

  it('does not postpone a schedule that another instance moved on after a failed attempt', async () => {
    setClock('2026-11-20T08:30:00Z');
    const created = await createScheduledWorkflow(app, tenant.apiKey, { cron: '0 9 * * *', timezone: 'UTC' });
    schedulers = await startInProcessSchedulers(1);
    const { executions, db } = internals();
    jest.spyOn(executions, 'enqueueWithin').mockRejectedValueOnce(new Error('database hiccup'));
    const run = db.run.bind(db);
    jest.spyOn(db, 'run').mockImplementationOnce(async (tenantId, work) => {
      await ctx.ds.query(`UPDATE "workflows" SET "nextRunAt" = '2026-11-21T09:00:00Z' WHERE "id" = $1`, [created.id]);
      return run(tenantId, work);
    });

    await tickAt('2026-11-20T09:00:05Z');

    const [workflow]: Array<Pick<Workflow, 'nextRunAt' | 'scheduleRetryAt'>> = await ctx.ds.query(
      `SELECT "nextRunAt", "scheduleRetryAt" FROM "workflows" WHERE "id" = $1`,
      [created.id],
    );
    expect(workflow.nextRunAt?.toISOString()).toBe('2026-11-21T09:00:00.000Z');
    expect(workflow.scheduleRetryAt).toBeNull();
  });

  it('claims a schedule that became due while the same tick was still firing others', async () => {
    setClock('2026-11-20T08:30:00Z');
    const first = await createScheduledWorkflow(app, tenant.apiKey, { cron: '0 9 * * *', timezone: 'UTC' });
    const later = await createScheduledWorkflow(app, tenant.apiKey, { cron: '1 9 * * *', timezone: 'UTC' });
    schedulers = await startInProcessSchedulers(1);
    const { executions } = internals();
    const enqueue = executions.enqueueWithin.bind(executions);
    jest.spyOn(executions, 'enqueueWithin').mockImplementation(async (...args) => {
      jest.setSystemTime(new Date('2026-11-20T09:01:05Z'));
      return enqueue(...args);
    });

    await tickAt('2026-11-20T09:00:05Z');

    expect(await cronRuns(first.id)).toHaveLength(1);
    expect(await cronRuns(later.id)).toHaveLength(1);
  });
});

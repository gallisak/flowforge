import { INestApplication } from '@nestjs/common';
import { QueryRunner } from 'typeorm';
import { Execution } from '../../../src/entities';
import { createTestApp } from '../../support/app';
import { restoreClock, setClock } from '../../support/clock';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant } from '../../support/db';
import { consistently, eventually } from '../../support/eventually';
import { createScheduledWorkflow, InProcessSchedulers, startInProcessSchedulers } from '../../support/scheduler';

describe('F-17 a slow scheduler tick does not overlap with the next one', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let tenant: SeededTenant;
  let schedulers: InProcessSchedulers | undefined;
  let blocker: QueryRunner | undefined;
  const savedTick = process.env.SCHEDULER_TICK_MS;

  async function sessionsWaitingForLocks(): Promise<number> {
    const [{ waiting }]: Array<{ waiting: number }> = await ctx.ds.query(
      `SELECT count(*)::int AS waiting FROM pg_locks
        WHERE NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    );
    return waiting;
  }

  beforeAll(async () => {
    app = await createTestApp();
    tenant = await seedTenant(ctx.ds, 'slow-tick');
  });

  afterAll(async () => {
    if (blocker && !blocker.isReleased) await blocker.release();
    await schedulers?.stop();
    await app?.close();
    restoreClock();
    if (savedTick === undefined) delete process.env.SCHEDULER_TICK_MS;
    else process.env.SCHEDULER_TICK_MS = savedTick;
  });

  it('fires an occurrence once when enqueueing it takes longer than the tick interval', async () => {
    setClock('2026-11-20T08:59:58Z');
    const workflow = await createScheduledWorkflow(app, tenant.apiKey, { cron: '* * * * *' });
    blocker = ctx.ds.createQueryRunner();
    await blocker.connect();
    await blocker.startTransaction();
    await blocker.query('LOCK TABLE "jobs" IN SHARE ROW EXCLUSIVE MODE');

    process.env.SCHEDULER_TICK_MS = '1000';
    schedulers = await startInProcessSchedulers(1);

    await eventually(async () => expect(await sessionsWaitingForLocks()).toBe(1), { timeoutMs: 10_000 });
    await consistently(async () => expect(await sessionsWaitingForLocks()).toBe(1), { timeoutMs: 3_500 });

    await blocker.rollbackTransaction();
    await blocker.release();

    const cronRuns = () => ctx.ds.getRepository(Execution).countBy({ workflowId: workflow.id, trigger: 'cron' });
    await eventually(async () => expect(await cronRuns()).toBe(1));
    await consistently(async () => expect(await cronRuns()).toBe(1));
  });
});

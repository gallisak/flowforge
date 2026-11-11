import { INestApplication } from '@nestjs/common';
import { Execution } from '../../../src/entities';
import { createTestApp } from '../../support/app';
import { restoreClock, setClock } from '../../support/clock';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant } from '../../support/db';
import { createScheduledWorkflow, InProcessSchedulers, startInProcessSchedulers } from '../../support/scheduler';

describe('F-15 a schedule fires at the local time of its time zone', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let tenant: SeededTenant;
  let schedulers: InProcessSchedulers | undefined;

  const cronRuns = (workflowId: string) => ctx.ds.getRepository(Execution).countBy({ workflowId, trigger: 'cron' });

  async function scheduleAt(now: string, schedule: Record<string, unknown>): Promise<string> {
    setClock(now);
    const workflow = await createScheduledWorkflow(app, tenant.apiKey, schedule);
    schedulers = await startInProcessSchedulers(1);
    return workflow.id;
  }

  async function tickAt(now: string): Promise<void> {
    setClock(now);
    await schedulers?.services[0].tick();
  }

  beforeAll(async () => {
    app = await createTestApp();
    tenant = await seedTenant(ctx.ds, 'time-zones');
  });

  afterEach(async () => {
    await schedulers?.stop();
    schedulers = undefined;
    restoreClock();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('fires a daily 09:00 New York schedule at 14:00 UTC in winter', async () => {
    const workflowId = await scheduleAt('2026-11-20T00:00:00Z', { cron: '0 9 * * *', timezone: 'America/New_York' });

    await tickAt('2026-11-20T13:59:55Z');
    expect(await cronRuns(workflowId)).toBe(0);

    await tickAt('2026-11-20T14:00:05Z');
    expect(await cronRuns(workflowId)).toBe(1);
  });

  it('fires a daily 09:00 New York schedule at 13:00 UTC in summer', async () => {
    const workflowId = await scheduleAt('2026-07-01T00:00:00Z', { cron: '0 9 * * *', timezone: 'America/New_York' });

    await tickAt('2026-07-01T12:59:55Z');
    expect(await cronRuns(workflowId)).toBe(0);

    await tickAt('2026-07-01T13:00:05Z');
    expect(await cronRuns(workflowId)).toBe(1);
  });

  it('fires once, an hour later, when the clocks spring forward over the scheduled time', async () => {
    const workflowId = await scheduleAt('2026-03-07T12:00:00Z', { cron: '30 2 * * *', timezone: 'America/New_York' });

    await tickAt('2026-03-08T06:59:55Z');
    expect(await cronRuns(workflowId)).toBe(0);

    await tickAt('2026-03-08T07:30:05Z');
    expect(await cronRuns(workflowId)).toBe(1);

    await tickAt('2026-03-09T06:30:05Z');
    expect(await cronRuns(workflowId)).toBe(2);
  });

  it('fires once when the clocks fall back and the scheduled time happens twice', async () => {
    const workflowId = await scheduleAt('2026-10-31T12:00:00Z', { cron: '30 1 * * *', timezone: 'America/New_York' });

    await tickAt('2026-11-01T05:30:05Z');
    expect(await cronRuns(workflowId)).toBe(1);

    await tickAt('2026-11-01T06:30:05Z');
    expect(await cronRuns(workflowId)).toBe(1);

    await tickAt('2026-11-02T06:30:05Z');
    expect(await cronRuns(workflowId)).toBe(2);
  });
});

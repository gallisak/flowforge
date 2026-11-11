import { INestApplication } from '@nestjs/common';
import { Execution } from '../../../src/entities';
import { createTestApp } from '../../support/app';
import { restoreClock, setClock } from '../../support/clock';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant } from '../../support/db';
import { createScheduledWorkflow, InProcessSchedulers, startInProcessSchedulers } from '../../support/scheduler';

const PARALLEL_TICKS = 10;

describe('F-14 several scheduler instances fire each occurrence once', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let tenant: SeededTenant;
  let schedulers: InProcessSchedulers | undefined;

  const cronRuns = (workflowId: string) => ctx.ds.getRepository(Execution).countBy({ workflowId, trigger: 'cron' });

  async function tickEverywhereAt(now: string): Promise<void> {
    setClock(now);
    const services = schedulers?.services ?? [];
    await Promise.all(Array.from({ length: PARALLEL_TICKS }, (_, i) => services[i % services.length].tick()));
  }

  beforeAll(async () => {
    app = await createTestApp();
    tenant = await seedTenant(ctx.ds, 'multi-instance');
  });

  afterEach(async () => {
    await schedulers?.stop();
    schedulers = undefined;
    restoreClock();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('creates one execution per occurrence when two instances tick at the same moment', async () => {
    setClock('2026-11-20T08:30:00Z');
    const workflow = await createScheduledWorkflow(app, tenant.apiKey, { cron: '0 * * * *' });
    schedulers = await startInProcessSchedulers(2);

    await tickEverywhereAt('2026-11-20T09:00:05Z');
    expect(await cronRuns(workflow.id)).toBe(1);

    await tickEverywhereAt('2026-11-20T10:00:05Z');
    expect(await cronRuns(workflow.id)).toBe(2);
  });

  it('creates one execution per workflow when many schedules are due together', async () => {
    setClock('2026-11-21T08:30:00Z');
    const workflows = await Promise.all(
      Array.from({ length: 20 }, () => createScheduledWorkflow(app, tenant.apiKey, { cron: '0 9 * * *', timezone: 'UTC' })),
    );
    schedulers = await startInProcessSchedulers(2);

    await tickEverywhereAt('2026-11-21T09:00:05Z');

    const runs = await Promise.all(workflows.map((workflow) => cronRuns(workflow.id)));
    expect(runs).toEqual(workflows.map(() => 1));
  });
});

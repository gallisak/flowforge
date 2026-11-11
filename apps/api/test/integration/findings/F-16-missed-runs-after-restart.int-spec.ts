import { INestApplication } from '@nestjs/common';
import { Execution, Job, Tenant } from '../../../src/entities';
import { createTestApp } from '../../support/app';
import { restoreClock, setClock } from '../../support/clock';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant, seedWorkflow } from '../../support/db';
import { createScheduledWorkflow, InProcessSchedulers, startInProcessSchedulers } from '../../support/scheduler';

describe('F-16 a restarted scheduler handles runs missed while it was down', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let tenant: SeededTenant;
  let schedulers: InProcessSchedulers | undefined;

  const cronRuns = (workflowId: string) => ctx.ds.getRepository(Execution).countBy({ workflowId, trigger: 'cron' });

  async function restartAfterTenHoursDown(schedule: Record<string, unknown>): Promise<string> {
    setClock('2026-11-20T08:30:00Z');
    const workflow = await createScheduledWorkflow(app, tenant.apiKey, { cron: '0 * * * *', ...schedule });
    const beforeOutage = await startInProcessSchedulers(1);
    setClock('2026-11-20T09:00:05Z');
    await beforeOutage.services[0].tick();
    await beforeOutage.stop();

    setClock('2026-11-20T19:30:00Z');
    schedulers = await startInProcessSchedulers(1);
    await schedulers.services[0].tick();
    return workflow.id;
  }

  beforeAll(async () => {
    app = await createTestApp();
    tenant = await seedTenant(ctx.ds, 'missed-runs');
  });

  afterEach(async () => {
    await schedulers?.stop();
    schedulers = undefined;
    restoreClock();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('runs the missed schedule once by default', async () => {
    const workflowId = await restartAfterTenHoursDown({});

    expect(await cronRuns(workflowId)).toBe(2);
  });

  it('runs every missed occurrence when the policy is all', async () => {
    const workflowId = await restartAfterTenHoursDown({ missedRunPolicy: 'all' });

    expect(await cronRuns(workflowId)).toBe(11);
  });

  it('runs none of the missed occurrences when the policy is skip', async () => {
    const workflowId = await restartAfterTenHoursDown({ missedRunPolicy: 'skip' });

    expect(await cronRuns(workflowId)).toBe(1);
  });

  it('retries an occurrence whose enqueue failed instead of dropping it', async () => {
    setClock('2026-11-20T08:30:00Z');
    const crowded = await seedTenant(ctx.ds, 'crowded');
    await ctx.ds.getRepository(Tenant).update(crowded.tenant.id, { maxQueuedJobs: 1 });
    const filler = await seedWorkflow(ctx.ds, crowded.tenant.id, [{ id: 'note', type: 'log', message: 'fill' }]);
    const queued = await ctx.ds.getRepository(Execution).save({ tenantId: crowded.tenant.id, workflowId: filler.id, input: {} });
    await ctx.ds.getRepository(Job).save({ tenantId: crowded.tenant.id, executionId: queued.id });
    const workflow = await createScheduledWorkflow(app, crowded.apiKey, { cron: '0 * * * *' });
    schedulers = await startInProcessSchedulers(1);

    setClock('2026-11-20T09:00:05Z');
    await schedulers.services[0].tick();
    expect(await cronRuns(workflow.id)).toBe(0);

    await ctx.ds.getRepository(Job).update({ tenantId: crowded.tenant.id }, { status: 'done' });
    setClock('2026-11-20T09:00:15Z');
    await schedulers.services[0].tick();
    expect(await cronRuns(workflow.id)).toBe(1);
  });
});

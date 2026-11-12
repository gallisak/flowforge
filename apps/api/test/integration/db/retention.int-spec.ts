import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Execution, Job, OutboxEvent, StepRun, Workflow, WorkflowVersion } from '../../../src/entities';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

const DAY_MS = 24 * 60 * 60 * 1000;
const STEPS = [{ id: 'note', type: 'log' as const, message: 'hi' }];

describe('data that would grow without limit', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let tenant: SeededTenant;
  let workers: InProcessWorkers | undefined;
  const names = ['RETENTION_DAYS', 'RETENTION_INTERVAL_MS'] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));

  beforeAll(async () => {
    app = await createTestApp();
    tenant = await seedTenant(ctx.ds, 'retention');
  });

  afterAll(async () => {
    await workers?.stop();
    await app?.close();
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it('does not add a version when an update repeats the current steps', async () => {
    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set('x-api-key', tenant.apiKey)
      .send({ name: 'same', steps: [{ type: 'log', id: 'note', message: 'hi' }] })
      .expect(201);

    const updated = await request(app.getHttpServer())
      .patch(`/workflows/${created.body.id}`)
      .set('x-api-key', tenant.apiKey)
      .send({ name: 'renamed', steps: [{ message: 'hi', id: 'note', type: 'log' }] })
      .expect(200);

    expect(updated.body.version).toBe(1);
    expect(await ctx.ds.getRepository(WorkflowVersion).countBy({ workflowId: created.body.id })).toBe(1);
  });

  async function seedExecution(workflow: Workflow, version: number, status: Execution['status'], finishedDaysAgo: number | null) {
    const execution = await ctx.ds.getRepository(Execution).save({
      tenantId: tenant.tenant.id,
      workflowId: workflow.id,
      workflowVersion: version,
      input: {},
      status,
      finishedAt: finishedDaysAgo === null ? null : new Date(Date.now() - finishedDaysAgo * DAY_MS),
    });
    const final = status === 'succeeded' || status === 'failed';
    await ctx.ds.getRepository(Job).save({ tenantId: tenant.tenant.id, executionId: execution.id, status: final ? 'done' : 'queued', runAt: new Date(Date.now() + DAY_MS) });
    await ctx.ds
      .getRepository(StepRun)
      .save({ tenantId: tenant.tenant.id, executionId: execution.id, stepIndex: 0, stepId: 'note', status: 'succeeded', attempts: 1, output: {} });
    if (final) {
      await ctx.ds.getRepository(OutboxEvent).save({
        tenantId: tenant.tenant.id,
        executionId: execution.id,
        type: 'execution.finished',
        payload: {},
        status: 'delivered',
        createdAt: new Date(Date.now() - (finishedDaysAgo ?? 0) * DAY_MS),
      });
    }
    return execution;
  }

  it('removes finished executions, their rows and versions nothing needs any more, after the retention period', async () => {
    const live = await seedWorkflow(ctx.ds, tenant.tenant.id, STEPS, { version: 3 });
    for (const version of [1, 2]) {
      await ctx.ds.getRepository(WorkflowVersion).insert({ tenantId: tenant.tenant.id, workflowId: live.id, version, steps: STEPS });
    }
    const deleted = await seedWorkflow(ctx.ds, tenant.tenant.id, STEPS);
    await ctx.ds.getRepository(Workflow).delete(deleted.id);
    const old = await seedExecution(live, 1, 'succeeded', 40);
    const recent = await seedExecution(live, 3, 'failed', 2);
    const waiting = await seedExecution(live, 2, 'waiting', null);
    process.env.RETENTION_DAYS = '30';
    process.env.RETENTION_INTERVAL_MS = '200';
    workers = await startInProcessWorkers(1);

    await eventually(async () => expect(await ctx.ds.getRepository(Execution).countBy({ id: old.id })).toBe(0));

    for (const [entity, column] of [
      [StepRun, 'executionId'],
      [Job, 'executionId'],
      [OutboxEvent, 'executionId'],
    ] as const) {
      expect(await ctx.ds.getRepository(entity).countBy({ [column]: old.id })).toBe(0);
      expect(await ctx.ds.getRepository(entity).countBy({ [column]: recent.id })).toBe(1);
      expect(await ctx.ds.getRepository(entity).countBy({ [column]: waiting.id })).toBe(entity === OutboxEvent ? 0 : 1);
    }
    await eventually(async () => {
      const versions = await ctx.ds.getRepository(WorkflowVersion).find({ where: { workflowId: live.id }, order: { version: 'ASC' } });
      expect(versions.map((v) => v.version)).toEqual([2, 3]);
      expect(await ctx.ds.getRepository(WorkflowVersion).countBy({ workflowId: deleted.id })).toBe(0);
    });
  });
});

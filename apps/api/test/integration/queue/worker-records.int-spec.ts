import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from '../../../src/app.module';
import { JobRunnerService } from '../../../src/engine/job-runner.service';
import { Execution, Job, NotificationEndpoint, OutboxEvent, StepRun } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { Receiver, startReceiver } from '../../support/receiver';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

describe('what a worker records about an execution', () => {
  const ctx = useIntegrationContext();
  let receiver: Receiver;
  let workers: InProcessWorkers | undefined;
  const saved = { base: process.env.RETRY_BASE_MS, cap: process.env.RETRY_CAP_MS };

  async function start(steps: Parameters<typeof seedWorkflow>[2], withEndpoint = false): Promise<Execution> {
    const { tenant } = await seedTenant(ctx.ds, `records-${Math.random()}`);
    if (withEndpoint) await ctx.ds.getRepository(NotificationEndpoint).save({ tenantId: tenant.id, url: `${receiver.url}/notify` });
    const workflow = await seedWorkflow(ctx.ds, tenant.id, steps);
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.id, workflowId: workflow.id, input: {} });
    await ctx.ds.getRepository(Job).save({ tenantId: tenant.id, executionId: execution.id });
    return execution;
  }

  const finished = (id: string) =>
    eventually(async () => {
      const current = await ctx.ds.getRepository(Execution).findOneByOrFail({ id });
      expect(['succeeded', 'failed']).toContain(current.status);
      return current;
    });

  beforeAll(async () => {
    process.env.RETRY_BASE_MS = '20';
    process.env.RETRY_CAP_MS = '50';
    receiver = await startReceiver();
  });

  afterEach(async () => {
    await workers?.stop();
    workers = undefined;
  });

  afterAll(async () => {
    await receiver?.close();
    for (const [name, value] of [
      ['RETRY_BASE_MS', saved.base],
      ['RETRY_CAP_MS', saved.cap],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('does not move an execution that another worker already finished back to running', async () => {
    const execution = await start([{ id: 'note', type: 'log', message: 'hi' }]);
    await ctx.ds.getRepository(Execution).update(execution.id, { status: 'succeeded', finishedAt: new Date() });
    await ctx.ds.getRepository(Job).update({ executionId: execution.id }, { status: 'done', attempts: 2 });
    const job = await ctx.ds.getRepository(Job).findOneByOrFail({ executionId: execution.id });
    const stalled: Job = { ...job, status: 'running', lockedBy: 'worker-paused', attempts: 1 };

    const context: INestApplicationContext = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error'] });
    try {
      await context.get(JobRunnerService).process(stalled);
    } finally {
      await context.close();
    }

    expect(await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id })).toMatchObject({ status: 'succeeded' });
  });

  it('clears the error of a failed attempt once the execution succeeds', async () => {
    let calls = 0;
    receiver.setHandler((_req, res) => {
      calls++;
      res.writeHead(calls === 1 ? 503 : 200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    const execution = await start([{ id: 'call', type: 'http', url: `${receiver.url}/flaky` }], true);
    workers = await startInProcessWorkers(1);

    const done = await finished(execution.id);

    expect(done).toMatchObject({ status: 'succeeded', error: null });
    const [event] = await eventually(async () => {
      const events = await ctx.ds.getRepository(OutboxEvent).findBy({ executionId: execution.id });
      expect(events).toHaveLength(1);
      return events;
    });
    expect((event.payload as { error: unknown }).error).toBeNull();
  });

  it('keeps a non-retryable step error when recording it fails once, and does not repeat the request', async () => {
    receiver.setHandler((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await ctx.ds.query(`CREATE SEQUENCE IF NOT EXISTS record_failure_once`);
    await ctx.ds.query(`GRANT USAGE ON SEQUENCE record_failure_once TO flowforge_app`);
    await ctx.ds.query(`
      CREATE OR REPLACE FUNCTION fail_recording_once() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."status" = 'failed' AND nextval('record_failure_once') = 1 THEN
          RAISE EXCEPTION 'canceling statement due to statement timeout';
        END IF;
        RETURN NEW;
      END $$`);
    await ctx.ds.query(`CREATE TRIGGER fail_recording_once BEFORE UPDATE ON step_runs FOR EACH ROW EXECUTE FUNCTION fail_recording_once()`);
    try {
      const execution = await start([{ id: 'create', type: 'http', method: 'POST', url: `${receiver.url}/missing` }]);
      workers = await startInProcessWorkers(1);

      const done = await finished(execution.id);

      expect(done).toMatchObject({ status: 'failed', error: 'http 404' });
      expect(receiver.requests.filter((r) => r.path === '/missing')).toHaveLength(1);
      expect(await ctx.ds.getRepository(StepRun).findOneByOrFail({ executionId: execution.id })).toMatchObject({
        status: 'failed',
        error: 'http 404',
      });
    } finally {
      await ctx.ds.query(`DROP TRIGGER fail_recording_once ON step_runs`);
    }
  });
});

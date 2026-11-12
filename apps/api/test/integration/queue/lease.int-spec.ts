import { JobQueueService } from '../../../src/engine/job-queue.service';
import { JobRunnerService } from '../../../src/engine/job-runner.service';
import { Execution, Job } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { settledCalls } from '../../support/spies';
import { seedTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { Receiver, startReceiver } from '../../support/receiver';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

const LEASE_SECONDS = 2;
const SLOW_STEP_MS = 5_000;

describe('job lease', () => {
  const ctx = useIntegrationContext();
  let receiver: Receiver;
  let workers: InProcessWorkers | undefined;
  const saved = {
    lease: process.env.WORKER_LEASE_SECONDS,
    statement: process.env.DB_STATEMENT_TIMEOUT_MS,
    reaper: process.env.WORKER_REAPER_INTERVAL_MS,
  };

  async function enqueueSlowJob(path: string): Promise<{ execution: Execution; job: Job }> {
    const { tenant } = await seedTenant(ctx.ds, `lease-${path}`);
    const workflow = await seedWorkflow(ctx.ds, tenant.id, [{ id: 'slow', type: 'http', url: `${receiver.url}${path}` }]);
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.id, workflowId: workflow.id, input: {} });
    const job = await ctx.ds.getRepository(Job).save({ tenantId: tenant.id, executionId: execution.id });
    return { execution, job };
  }

  beforeAll(async () => {
    process.env.WORKER_LEASE_SECONDS = String(LEASE_SECONDS);
    process.env.DB_STATEMENT_TIMEOUT_MS = '1500';
    process.env.WORKER_REAPER_INTERVAL_MS = '200';
    receiver = await startReceiver((req, res) => {
      setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'), SLOW_STEP_MS);
    });
  });

  afterEach(async () => {
    await workers?.stop();
    workers = undefined;
  });

  afterAll(async () => {
    await receiver?.close();
    for (const [name, value] of [
      ['WORKER_LEASE_SECONDS', saved.lease],
      ['DB_STATEMENT_TIMEOUT_MS', saved.statement],
      ['WORKER_REAPER_INTERVAL_MS', saved.reaper],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('is renewed while a step runs longer than the lease, so no other worker takes the job', async () => {
    const { job } = await enqueueSlowJob('/slow-but-alive');

    workers = await startInProcessWorkers(2);

    await eventually(async () => expect(await ctx.ds.getRepository(Job).findOneByOrFail({ id: job.id })).toMatchObject({ status: 'done' }), {
      timeoutMs: 20_000,
    });
    expect(receiver.requests.filter((r) => r.path === '/slow-but-alive')).toHaveLength(1);
    expect(await ctx.ds.getRepository(Job).findOneByOrFail({ id: job.id })).toMatchObject({ attempts: 1 });
  });

  it('is not given up because of a renewal that failed for a moment', async () => {
    workers = await startInProcessWorkers(1);
    const queue = workers.contexts[0].get(JobQueueService);
    const renew = queue.extendLease.bind(queue);
    let hiccups = 1;
    jest.spyOn(queue, 'extendLease').mockImplementation(async (...args) => {
      if (hiccups-- > 0) throw new Error('Connection terminated unexpectedly');
      return renew(...args);
    });
    const { job } = await enqueueSlowJob('/database-hiccup');

    await eventually(async () => expect(await ctx.ds.getRepository(Job).findOneByOrFail({ id: job.id })).toMatchObject({ status: 'done' }), {
      timeoutMs: 20_000,
    });
    expect(receiver.requests.filter((r) => r.path === '/database-hiccup')).toHaveLength(1);
    expect(await ctx.ds.getRepository(Job).findOneByOrFail({ id: job.id })).toMatchObject({ attempts: 1 });
  });

  it('cannot be used to complete a job after it was taken over by someone else', async () => {
    const { execution, job } = await enqueueSlowJob('/taken-over');
    const processed = jest.spyOn(JobRunnerService.prototype, 'process');
    ctx.onTeardown(() => processed.mockRestore());

    workers = await startInProcessWorkers(1);
    await eventually(() => expect(receiver.requests.some((r) => r.path === '/taken-over')).toBe(true));
    await ctx.ds
      .getRepository(Job)
      .update(job.id, { lockedBy: 'another-worker', lockedUntil: new Date(Date.now() + 3_600_000) });

    await settledCalls(processed);

    expect(await ctx.ds.getRepository(Job).findOneByOrFail({ id: job.id })).toMatchObject({
      status: 'running',
      lockedBy: 'another-worker',
    });
    expect((await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id })).status).not.toBe('succeeded');
  });
});

import { Execution, Job } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { Receiver, startReceiver } from '../../support/receiver';
import { spawnWorkerProcess, WorkerProcess } from '../../support/worker';

describe('F-05 a worker that is asked to stop does not lose its current job', () => {
  const ctx = useIntegrationContext();
  let receiver: Receiver;
  let worker: WorkerProcess | undefined;

  async function enqueue(path: string): Promise<{ execution: Execution; job: Job }> {
    const { tenant } = await seedTenant(ctx.ds, `shutdown-${path.replace(/\W/g, '')}-${Date.now()}`);
    const workflow = await seedWorkflow(ctx.ds, tenant.id, [{ id: 'call', type: 'http', url: `${receiver.url}${path}` }]);
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.id, workflowId: workflow.id, input: {} });
    const job = await ctx.ds.getRepository(Job).save({ tenantId: tenant.id, executionId: execution.id });
    return { execution, job };
  }

  async function startWorker(graceMs: number): Promise<WorkerProcess> {
    const process = spawnWorkerProcess({
      DATABASE_URL: ctx.db.url,
      WORKER_CONCURRENCY: '1',
      WORKER_SHUTDOWN_GRACE_MS: String(graceMs),
    });
    await process.waitForOutput(/started, concurrency=1/);
    return process;
  }

  beforeAll(async () => {
    receiver = await startReceiver((req, res) => {
      if (req.path === '/hang') return;
      setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'), 1_500);
    });
  });

  afterEach(async () => {
    await worker?.kill('SIGKILL');
    worker = undefined;
  });

  afterAll(async () => {
    await receiver?.close();
  });

  it('finishes a job that completes within the grace period before exiting', async () => {
    const { execution, job } = await enqueue('/finishes-in-time');
    worker = await startWorker(10_000);
    await eventually(() => expect(receiver.requests.some((r) => r.path === '/finishes-in-time')).toBe(true));
    const waiting = await enqueue('/never-claimed');

    worker.child.kill('SIGTERM');
    await worker.waitForExit(20_000);

    expect(await ctx.ds.getRepository(Job).findOneByOrFail({ id: job.id })).toMatchObject({ status: 'done' });
    expect(await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id })).toMatchObject({ status: 'succeeded' });
    expect(await ctx.ds.getRepository(Job).findOneByOrFail({ id: waiting.job.id })).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it('returns a job that cannot finish within the grace period to the queue', async () => {
    const { execution, job } = await enqueue('/hang');
    worker = await startWorker(1_000);
    await eventually(() => expect(receiver.requests.some((r) => r.path === '/hang')).toBe(true));

    worker.child.kill('SIGTERM');
    await worker.waitForExit(20_000);

    expect(await ctx.ds.getRepository(Job).findOneByOrFail({ id: job.id })).toMatchObject({
      status: 'queued',
      lockedBy: null,
      attempts: 0,
    });
    expect(await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id })).toMatchObject({ status: 'pending' });
  });
});

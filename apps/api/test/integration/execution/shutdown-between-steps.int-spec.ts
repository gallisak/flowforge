import { Execution, Job, StepRun } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { Receiver, startReceiver } from '../../support/receiver';
import { spawnWorkerProcess, WorkerProcess } from '../../support/worker';

describe('a worker asked to stop does not start the next step', () => {
  const ctx = useIntegrationContext();
  let receiver: Receiver;
  let worker: WorkerProcess | undefined;

  beforeAll(async () => {
    receiver = await startReceiver((req, res) => {
      const delayMs = req.path === '/first' ? 1_500 : 0;
      setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'), delayMs);
    });
  });

  afterAll(async () => {
    await worker?.kill('SIGKILL');
    await receiver?.close();
  });

  it('finishes the step in flight, then returns the job to the queue at the step boundary', async () => {
    const { tenant } = await seedTenant(ctx.ds, 'step-boundary');
    const workflow = await seedWorkflow(ctx.ds, tenant.id, [
      { id: 'first', type: 'http', url: `${receiver.url}/first` },
      { id: 'second', type: 'http', url: `${receiver.url}/second` },
    ]);
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.id, workflowId: workflow.id, input: {} });
    const job = await ctx.ds.getRepository(Job).save({ tenantId: tenant.id, executionId: execution.id });
    worker = spawnWorkerProcess({ DATABASE_URL: ctx.db.url, WORKER_CONCURRENCY: '1', WORKER_SHUTDOWN_GRACE_MS: '10000' });
    await worker.waitForOutput(/started, concurrency=1/);
    await eventually(() => expect(receiver.requests.some((r) => r.path === '/first')).toBe(true));

    worker.child.kill('SIGTERM');
    await worker.waitForExit(20_000);

    expect(receiver.requests.some((r) => r.path === '/second')).toBe(false);
    expect(await ctx.ds.getRepository(StepRun).findBy({ executionId: execution.id })).toEqual([
      expect.objectContaining({ stepId: 'first', status: 'succeeded' }),
    ]);
    expect(await ctx.ds.getRepository(Job).findOneByOrFail({ id: job.id })).toMatchObject({ status: 'queued', lockedBy: null, attempts: 0 });
    expect(await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id })).toMatchObject({ status: 'pending' });
  });
});

import { Execution, Job, StepRun } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { Receiver, startReceiver } from '../../support/receiver';
import { InProcessWorkers, spawnWorkerProcess, startInProcessWorkers, WorkerProcess } from '../../support/worker';

describe('chaos: a worker is killed in the middle of a step', () => {
  const ctx = useIntegrationContext();
  let receiver: Receiver;
  let spawned: WorkerProcess | undefined;
  let workers: InProcessWorkers | undefined;
  let execution: Execution;
  let job: Job;
  const appliedEffects = new Set<string>();
  let chargeRequests = 0;
  const saved = {
    lease: process.env.WORKER_LEASE_SECONDS,
    statement: process.env.DB_STATEMENT_TIMEOUT_MS,
    reaper: process.env.WORKER_REAPER_INTERVAL_MS,
  };

  beforeAll(async () => {
    process.env.WORKER_LEASE_SECONDS = '2';
    process.env.DB_STATEMENT_TIMEOUT_MS = '1500';
    process.env.WORKER_REAPER_INTERVAL_MS = '200';
    receiver = await startReceiver((req, res) => {
      appliedEffects.add(`${req.path} ${String(req.headers['idempotency-key'])}`);
      if (req.path === '/charge' && chargeRequests++ === 0) return;
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });

    const { tenant } = await seedTenant(ctx.ds, 'chaos');
    const workflow = await seedWorkflow(ctx.ds, tenant.id, [
      { id: 'reserve', type: 'http', url: `${receiver.url}/reserve`, method: 'POST' },
      { id: 'charge', type: 'http', url: `${receiver.url}/charge`, method: 'POST' },
      { id: 'email', type: 'http', url: `${receiver.url}/email`, method: 'POST' },
    ]);
    execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.id, workflowId: workflow.id, input: {} });
    job = await ctx.ds.getRepository(Job).save({ tenantId: tenant.id, executionId: execution.id });

    spawned = spawnWorkerProcess({
      DATABASE_URL: ctx.db.url,
      WORKER_CONCURRENCY: '1',
      WORKER_LEASE_SECONDS: '2',
      WORKER_REAPER_INTERVAL_MS: '200',
    });
    await eventually(() => expect(chargeRequests).toBe(1));
    const killed = await spawned.kill('SIGKILL');
    expect(killed.signal).toBe('SIGKILL');
    spawned = undefined;

    workers = await startInProcessWorkers(1);
    await eventually(
      async () => expect(await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id })).toMatchObject({ status: 'succeeded' }),
      { timeoutMs: 20_000 },
    );
  });

  afterAll(async () => {
    await spawned?.kill('SIGKILL');
    await workers?.stop();
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

  const requestsTo = (path: string) => receiver.requests.filter((r) => r.path === path);

  it('picks the job up again and finishes the execution', async () => {
    expect(await ctx.ds.getRepository(Job).findOneByOrFail({ id: job.id })).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('does not repeat the step that finished before the crash', () => {
    expect(requestsTo('/reserve')).toHaveLength(1);
  });

  it('repeats the interrupted step with the same idempotency key', () => {
    const keys = requestsTo('/charge').map((r) => r.headers['idempotency-key']);
    expect(keys).toEqual([`${execution.id}:charge`, `${execution.id}:charge`]);
  });

  it('applies every external side effect exactly once for a receiver that honours the key', () => {
    expect([...appliedEffects].sort()).toEqual([
      `/charge ${execution.id}:charge`,
      `/email ${execution.id}:email`,
      `/reserve ${execution.id}:reserve`,
    ]);
    expect(receiver.requests).toHaveLength(4);
  });

  it('records one checkpoint per step with the attempts it took', async () => {
    const runs = await ctx.ds.getRepository(StepRun).find({ where: { executionId: execution.id }, order: { stepIndex: 'ASC' } });
    expect(runs.map((r) => [r.stepId, r.status, r.attempts])).toEqual([
      ['reserve', 'succeeded', 1],
      ['charge', 'succeeded', 2],
      ['email', 'succeeded', 1],
    ]);
  });
});

import { Execution, Job, StepRun } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { Receiver, startReceiver } from '../../support/receiver';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

const JOBS = 60;
const WORKERS = 4;
const SLOTS_PER_WORKER = 4;

describe('F-03 each queued job is executed exactly once by concurrent workers', () => {
  const ctx = useIntegrationContext();
  let receiver: Receiver;
  let workers: InProcessWorkers | undefined;

  beforeAll(async () => {
    receiver = await startReceiver();
    const { tenant } = await seedTenant(ctx.ds, 'busy-tenant');
    const workflow = await seedWorkflow(ctx.ds, tenant.id, [
      { id: 'call', type: 'http', url: `${receiver.url}/side-effect?n={{ input.n }}` },
    ]);
    for (let n = 0; n < JOBS; n++) {
      const execution = await ctx.ds
        .getRepository(Execution)
        .save({ tenantId: tenant.id, workflowId: workflow.id, input: { n } });
      await ctx.ds.getRepository(Job).save({ tenantId: tenant.id, executionId: execution.id });
    }

    workers = await startInProcessWorkers(WORKERS, SLOTS_PER_WORKER);
    await eventually(
      async () => expect(await ctx.ds.getRepository(Job).countBy({ status: 'done' })).toBe(JOBS),
      { timeoutMs: 30_000 },
    );
    await workers.stop();
    workers = undefined;
  });

  afterAll(async () => {
    await workers?.stop();
    await receiver?.close();
  });

  it('performs the side effect of every job exactly once', () => {
    const hits = receiver.requests.map((r) => new URL(r.path, receiver.url).searchParams.get('n'));
    expect(hits).toHaveLength(JOBS);
    expect(new Set(hits).size).toBe(JOBS);
  });

  it('records exactly one step run per execution', async () => {
    const rows: Array<{ runs: number }> = await ctx.ds.query(
      `SELECT count(s.id)::int AS runs FROM executions e LEFT JOIN step_runs s ON s."executionId" = e.id GROUP BY e.id`,
    );
    expect(rows).toHaveLength(JOBS);
    expect(rows.every((row) => row.runs === 1)).toBe(true);
    expect(await ctx.ds.getRepository(StepRun).count()).toBe(JOBS);
  });

  it('claims every job only once', async () => {
    const attempts = await ctx.ds.getRepository(Job).find({ select: { attempts: true } });
    expect(attempts.map((job) => job.attempts)).toEqual(Array(JOBS).fill(1));
  });
});

import { Execution, Job } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { Receiver, startReceiver } from '../../support/receiver';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

const RETRY_BASE_MS = 300;
const RETRY_CAP_MS = 600;

describe('job retries', () => {
  const ctx = useIntegrationContext();
  let receiver: Receiver;
  let workers: InProcessWorkers;
  const plannedResponses = new Map<string, number[]>();
  const saved = { base: process.env.RETRY_BASE_MS, cap: process.env.RETRY_CAP_MS };

  async function runAgainst(path: string, responses: number[]): Promise<{ execution: Execution; job: Job }> {
    plannedResponses.set(path, responses);
    const { tenant } = await seedTenant(ctx.ds, `retries${path.replace(/\W/g, '-')}`);
    const workflow = await seedWorkflow(ctx.ds, tenant.id, [{ id: 'call', type: 'http', url: `${receiver.url}${path}` }]);
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.id, workflowId: workflow.id, input: {} });
    const job = await ctx.ds.getRepository(Job).save({ tenantId: tenant.id, executionId: execution.id, maxAttempts: 3 });
    return { execution, job };
  }

  const hitsOf = (path: string) => receiver.requests.filter((r) => r.path === path);
  const jobOf = (id: string) => ctx.ds.getRepository(Job).findOneByOrFail({ id });
  const executionOf = (id: string) => ctx.ds.getRepository(Execution).findOneByOrFail({ id });

  beforeAll(async () => {
    process.env.RETRY_BASE_MS = String(RETRY_BASE_MS);
    process.env.RETRY_CAP_MS = String(RETRY_CAP_MS);
    receiver = await startReceiver((req, res) => {
      const planned = plannedResponses.get(req.path) ?? [200];
      const status = planned.length > 1 ? (planned.shift() as number) : planned[0];
      res.writeHead(status, { 'content-type': 'application/json' }).end('{}');
    });
    workers = await startInProcessWorkers(1, 2);
  });

  afterAll(async () => {
    await workers?.stop();
    await receiver?.close();
    for (const [name, value] of [
      ['RETRY_BASE_MS', saved.base],
      ['RETRY_CAP_MS', saved.cap],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('retries a retryable failure with a growing, jittered delay until it succeeds', async () => {
    const { execution, job } = await runAgainst('/flaky', [503, 503, 200]);

    await eventually(async () => expect(await jobOf(job.id)).toMatchObject({ status: 'done', attempts: 3 }));

    expect(await executionOf(execution.id)).toMatchObject({ status: 'succeeded' });
    const times = hitsOf('/flaky').map((r) => r.receivedAt);
    expect(times).toHaveLength(3);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(RETRY_BASE_MS - 50);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(RETRY_BASE_MS - 50);
  });

  it('retries a rate-limited request', async () => {
    const { job } = await runAgainst('/rate-limited', [429, 200]);
    await eventually(async () => expect(await jobOf(job.id)).toMatchObject({ status: 'done', attempts: 2 }));
  });

  it('does not retry a non-retryable failure', async () => {
    const { execution, job } = await runAgainst('/missing', [404]);

    await eventually(async () => expect(await jobOf(job.id)).toMatchObject({ status: 'failed', attempts: 1, lastError: 'http 404' }));

    expect(await executionOf(execution.id)).toMatchObject({ status: 'failed', error: 'http 404' });
    expect(hitsOf('/missing')).toHaveLength(1);
  });

  it('marks a job dead once every attempt failed with a retryable error', async () => {
    const { execution, job } = await runAgainst('/always-down', [500]);

    await eventually(async () => expect(await jobOf(job.id)).toMatchObject({ status: 'dead', attempts: 3, lockedBy: null }));

    expect(await executionOf(execution.id)).toMatchObject({
      status: 'failed',
      error: 'http 500 (gave up after 3 attempts)',
    });
    expect(hitsOf('/always-down')).toHaveLength(3);
  });

  it('retries when the remote host cannot be reached', async () => {
    const { tenant } = await seedTenant(ctx.ds, 'retries-unreachable');
    const workflow = await seedWorkflow(ctx.ds, tenant.id, [{ id: 'call', type: 'http', url: 'http://127.0.0.1:1/unreachable' }]);
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.id, workflowId: workflow.id, input: {} });
    const job = await ctx.ds.getRepository(Job).save({ tenantId: tenant.id, executionId: execution.id, maxAttempts: 2 });

    await eventually(async () =>
      expect(await jobOf(job.id)).toMatchObject({ status: 'dead', attempts: 2, lastError: 'http request failed: connection error' }),
    );
  });
});

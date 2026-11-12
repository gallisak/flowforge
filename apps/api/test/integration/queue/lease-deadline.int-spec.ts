import { JobQueueService } from '../../../src/engine/job-queue.service';
import { Execution, Job } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { Receiver, startReceiver } from '../../support/receiver';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

describe('a worker whose lease renewals hang', () => {
  const ctx = useIntegrationContext();
  let receiver: Receiver;
  let workers: InProcessWorkers;
  let requestedAt = 0;
  let abortedAt = 0;
  const saved = {
    lease: process.env.WORKER_LEASE_SECONDS,
    statement: process.env.DB_STATEMENT_TIMEOUT_MS,
    reaper: process.env.WORKER_REAPER_INTERVAL_MS,
  };

  beforeAll(async () => {
    process.env.WORKER_LEASE_SECONDS = '3';
    process.env.DB_STATEMENT_TIMEOUT_MS = '1500';
    process.env.WORKER_REAPER_INTERVAL_MS = '600000';
    jest.spyOn(JobQueueService.prototype, 'extendLease').mockImplementation(() => new Promise<boolean>(() => undefined));
    receiver = await startReceiver((_req, res) => {
      requestedAt = Date.now();
      res.on('close', () => {
        if (!res.writableEnded) abortedAt = Date.now();
      });
      setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end('{}'), 15_000).unref();
    });
    workers = await startInProcessWorkers(1);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
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

  it('stops its step before the lease runs out instead of waiting for the renewal to time out', async () => {
    const { tenant } = await seedTenant(ctx.ds, 'lease-deadline');
    const workflow = await seedWorkflow(ctx.ds, tenant.id, [{ id: 'slow', type: 'http', url: `${receiver.url}/slow` }]);
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.id, workflowId: workflow.id, input: {} });
    await ctx.ds.getRepository(Job).save({ tenantId: tenant.id, executionId: execution.id });

    await eventually(() => expect(abortedAt).toBeGreaterThan(0), { timeoutMs: 10_000 });

    expect(abortedAt - requestedAt).toBeLessThan(3_000);
  });
});

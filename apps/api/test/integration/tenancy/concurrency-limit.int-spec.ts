import { Execution, Job, Tenant } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { Receiver, startReceiver } from '../../support/receiver';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

describe('tenant concurrency limit', () => {
  const ctx = useIntegrationContext();
  let receiver: Receiver;
  let workers: InProcessWorkers;
  const inFlight = new Map<string, number>();
  const peak = new Map<string, number>();
  const saved = process.env.TENANT_MAX_CONCURRENT_JOBS;

  async function tenantWithSlowJobs(name: string, count: number, maxConcurrentJobs: number | null): Promise<string> {
    const { tenant } = await seedTenant(ctx.ds, name);
    await ctx.ds.getRepository(Tenant).update(tenant.id, { maxConcurrentJobs });
    const workflow = await seedWorkflow(ctx.ds, tenant.id, [{ id: 'slow', type: 'http', url: `${receiver.url}/${name}` }]);
    const executions = await ctx.ds
      .getRepository(Execution)
      .save(Array.from({ length: count }, () => ({ tenantId: tenant.id, workflowId: workflow.id, input: {} })));
    await ctx.ds.getRepository(Job).save(executions.map((e) => ({ tenantId: tenant.id, executionId: e.id })));
    return tenant.id;
  }

  beforeAll(async () => {
    process.env.TENANT_MAX_CONCURRENT_JOBS = '3';
    receiver = await startReceiver(async (req, res) => {
      const current = (inFlight.get(req.path) ?? 0) + 1;
      inFlight.set(req.path, current);
      peak.set(req.path, Math.max(peak.get(req.path) ?? 0, current));
      await new Promise((resolve) => setTimeout(resolve, 300));
      inFlight.set(req.path, (inFlight.get(req.path) ?? 1) - 1);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });

  afterAll(async () => {
    await workers?.stop();
    await receiver?.close();
    if (saved === undefined) delete process.env.TENANT_MAX_CONCURRENT_JOBS;
    else process.env.TENANT_MAX_CONCURRENT_JOBS = saved;
  });

  it('never runs more jobs of a tenant at once than its limit while other tenants use the spare slots', async () => {
    const limited = await tenantWithSlowJobs('limited', 8, 2);
    const defaulted = await tenantWithSlowJobs('defaulted', 8, null);
    workers = await startInProcessWorkers(2, 4);

    for (const tenantId of [limited, defaulted]) {
      await eventually(async () => expect(await ctx.ds.getRepository(Job).countBy({ tenantId, status: 'done' })).toBe(8), {
        timeoutMs: 30_000,
      });
    }

    expect(peak.get('/limited')).toBe(2);
    expect(peak.get('/defaulted')).toBe(3);
  });
});

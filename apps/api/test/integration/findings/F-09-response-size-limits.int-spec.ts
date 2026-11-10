import { Execution, Job, StepRun } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { Receiver, startReceiver } from '../../support/receiver';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

const MB = 1024 * 1024;

describe('F-09 step results have a size limit', () => {
  const ctx = useIntegrationContext();
  let receiver: Receiver;
  let workers: InProcessWorkers;
  let bytesSent = 0;

  async function run(steps: Parameters<typeof seedWorkflow>[2]): Promise<Execution> {
    const { tenant } = await seedTenant(ctx.ds, `limits-${Date.now()}-${Math.random()}`);
    const workflow = await seedWorkflow(ctx.ds, tenant.id, steps);
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.id, workflowId: workflow.id, input: {} });
    await ctx.ds.getRepository(Job).save({ tenantId: tenant.id, executionId: execution.id });
    return eventually(async () => {
      const current = await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id });
      expect(['succeeded', 'failed']).toContain(current.status);
      return current;
    });
  }

  beforeAll(async () => {
    receiver = await startReceiver(async (req, res) => {
      const chunk = Buffer.alloc(64 * 1024, 'a');
      if (req.path === '/declared') res.writeHead(200, { 'content-length': String(50 * MB) });
      else res.writeHead(200, { 'content-type': 'text/plain' });
      for (let sent = 0; sent < 50 * MB && !res.destroyed; sent += chunk.length) {
        if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve).once('close', resolve));
        bytesSent += chunk.length;
      }
      res.end();
    });
    workers = await startInProcessWorkers(1);
  });

  afterAll(async () => {
    await workers?.stop();
    await receiver?.close();
  });

  it('stops reading a response body that grows past the limit', async () => {
    bytesSent = 0;
    const execution = await run([{ id: 'download', type: 'http', url: `${receiver.url}/streamed` }]);

    expect(execution.status).toBe('failed');
    expect(execution.error).toMatch(/response body exceeds/);
    expect(bytesSent).toBeLessThan(20 * MB);
  });

  it('refuses a response that declares a length above the limit', async () => {
    const execution = await run([{ id: 'download', type: 'http', url: `${receiver.url}/declared` }]);

    expect(execution.status).toBe('failed');
    expect(execution.error).toMatch(/response body exceeds/);
  });

  it('refuses to store an oversized step output', async () => {
    const execution = await run([{ id: 'inflate', type: 'transform', expr: "'x'.repeat(8 * 1024 * 1024)" }]);

    expect(execution.status).toBe('failed');
    expect(execution.error).toMatch(/output exceeds/);
    const stored = await ctx.ds.getRepository(StepRun).findOneByOrFail({ executionId: execution.id });
    expect(stored.output).toBeNull();
  });
});

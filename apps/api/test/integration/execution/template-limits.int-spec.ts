import { Execution, Job } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { Receiver, startReceiver } from '../../support/receiver';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

describe('templates that grow a step beyond its limits', () => {
  const ctx = useIntegrationContext();
  let receiver: Receiver;
  let workers: InProcessWorkers;

  async function run(steps: Parameters<typeof seedWorkflow>[2]): Promise<Execution> {
    const { tenant } = await seedTenant(ctx.ds, `template-limits-${Math.random()}`);
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
    receiver = await startReceiver();
    workers = await startInProcessWorkers(1);
  });

  afterAll(async () => {
    await workers?.stop();
    await receiver?.close();
  });

  const big = { id: 'big', type: 'transform' as const, expr: "'x'.repeat(900 * 1024)" };

  it('fails an http step whose rendered body is too large, without sending it or retrying', async () => {
    const execution = await run([
      big,
      { id: 'post', type: 'http', method: 'POST', url: `${receiver.url}/body`, body: '{"a": "{{ steps.big }}", "b": "{{ steps.big }}"}' },
    ]);

    expect(execution.status).toBe('failed');
    expect(execution.error).toMatch(/^http body exceeds \d+ characters after rendering$/);
    const job = await ctx.ds.getRepository(Job).findOneByOrFail({ executionId: execution.id });
    expect(job.attempts).toBe(1);
    expect(receiver.requests.filter((r) => r.path === '/body')).toHaveLength(0);
  });

  it('fails an http step whose rendered url is too large', async () => {
    const execution = await run([big, { id: 'get', type: 'http', url: `${receiver.url}/url?a={{ steps.big }}` }]);

    expect(execution.status).toBe('failed');
    expect(execution.error).toMatch(/^http url exceeds \d+ characters after rendering$/);
    expect(receiver.requests.filter((r) => r.path.startsWith('/url'))).toHaveLength(0);
  });
});

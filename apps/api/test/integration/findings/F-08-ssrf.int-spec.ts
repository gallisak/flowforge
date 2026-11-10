import { Execution, Job } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { Receiver, startReceiver } from '../../support/receiver';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

describe('F-08 an http step cannot reach internal addresses', () => {
  const ctx = useIntegrationContext();
  let internal: Receiver;
  let gateway: Receiver;
  let workers: InProcessWorkers;
  const saved = process.env.SSRF_ALLOWLIST;

  const portOf = (receiver: Receiver) => new URL(receiver.url).port;
  const hits = (path: string) => internal.requests.filter((r) => r.path === path).length;

  async function runHttp(url: string): Promise<Execution> {
    const { tenant } = await seedTenant(ctx.ds, `ssrf-${Date.now()}-${Math.random()}`);
    const workflow = await seedWorkflow(ctx.ds, tenant.id, [{ id: 'call', type: 'http', url }]);
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.id, workflowId: workflow.id, input: {} });
    await ctx.ds.getRepository(Job).save({ tenantId: tenant.id, executionId: execution.id });
    return eventually(async () => {
      const current = await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id });
      expect(['succeeded', 'failed']).toContain(current.status);
      return current;
    });
  }

  beforeAll(async () => {
    internal = await startReceiver();
    gateway = await startReceiver((req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${portOf(internal)}${req.path.replace('/redirect', '')}` }).end();
    });
    process.env.SSRF_ALLOWLIST = `127.0.0.1:${portOf(gateway)}`;
    workers = await startInProcessWorkers(1);
  });

  afterAll(async () => {
    await workers?.stop();
    await internal?.close();
    await gateway?.close();
    if (saved === undefined) delete process.env.SSRF_ALLOWLIST;
    else process.env.SSRF_ALLOWLIST = saved;
  });

  it.each([
    ['loopback address', (port: string) => `http://127.0.0.1:${port}/loopback`, '/loopback'],
    ['localhost name', (port: string) => `http://localhost:${port}/localhost`, '/localhost'],
    ['name in upper case with a trailing dot', (port: string) => `http://LOCALHOST.:${port}/dotted`, '/dotted'],
    ['short loopback form', (port: string) => `http://127.1:${port}/short`, '/short'],
    ['decimal loopback form', (port: string) => `http://2130706433:${port}/decimal`, '/decimal'],
    ['hexadecimal loopback form', (port: string) => `http://0x7f.0.0.1:${port}/hex`, '/hex'],
    ['redirect from an allowed host', () => `${gateway.url}/redirect/redirected`, '/redirected'],
  ])('blocks a %s', async (_name, urlFor, path) => {
    const execution = await runHttp(urlFor(portOf(internal)));

    expect(hits(path)).toBe(0);
    expect(execution.status).toBe('failed');
    expect(execution.error).toMatch(/destination is not allowed/);
  });
});

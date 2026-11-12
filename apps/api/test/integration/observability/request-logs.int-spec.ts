import { createServer } from 'net';
import { AddressInfo } from 'net';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { AppProcess, spawnAppProcess } from '../../support/process';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('request logs of the api', () => {
  const ctx = useIntegrationContext();
  let api: AppProcess;
  let baseUrl: string;

  const logLines = (): Array<Record<string, unknown>> =>
    api
      .output()
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    api = spawnAppProcess('main', { DATABASE_URL: ctx.db.url, PORT: String(port), LOG_LEVEL: 'info' });
    await api.waitForOutput(/flowforge-api listening/);
  });

  afterAll(async () => {
    await api?.kill('SIGKILL');
  });

  it('writes one line per request and a line for the execution it created, both with the request id', async () => {
    const { tenant, apiKey } = await seedTenant(ctx.ds, 'logged');
    const workflow = await seedWorkflow(ctx.ds, tenant.id, [{ id: 'note', type: 'log', message: 'hi' }]);

    const response = await fetch(`${baseUrl}/workflows/${workflow.id}/run`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'x-request-id': 'logged-run-1', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };

    await eventually(() => {
      const lines = logLines();
      expect(lines).toContainEqual(
        expect.objectContaining({
          msg: 'request completed',
          method: 'POST',
          route: '/workflows/:id/run',
          status: 201,
          correlationId: 'logged-run-1',
          tenantId: tenant.id,
          durationMs: expect.any(Number),
        }),
      );
      expect(lines).toContainEqual(
        expect.objectContaining({ msg: 'execution created', executionId: id, correlationId: 'logged-run-1', trigger: 'api' }),
      );
    });
  });

  it('logs rejected requests too, without the api key', async () => {
    await fetch(`${baseUrl}/workflows`, { headers: { 'x-api-key': 'ff_wrong_key', 'x-request-id': 'logged-reject-1' } });

    await eventually(() =>
      expect(logLines()).toContainEqual(expect.objectContaining({ msg: 'request completed', status: 401, correlationId: 'logged-reject-1' })),
    );
    expect(api.output()).not.toContain('ff_wrong_key');
  });
});

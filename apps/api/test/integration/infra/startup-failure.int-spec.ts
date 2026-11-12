import { useIntegrationContext } from '../../support/context';
import { spawnAppProcess } from '../../support/process';

describe('a service that cannot start', () => {
  const ctx = useIntegrationContext();

  it.each(['main', 'worker', 'scheduler'] as const)('%s logs one structured error and exits with code 1', async (entrypoint) => {
    const service = spawnAppProcess(entrypoint, { DATABASE_URL: ctx.db.ownerUrl, METRICS_PORT: '0', PORT: '0' });

    const exit = await service.waitForExit(30_000);

    expect(exit.code).toBe(1);
    const line = service
      .output()
      .split('\n')
      .find((text) => text.includes('"startup failed"'));
    expect(line).toBeDefined();
    expect(JSON.parse(line as string)).toMatchObject({ level: 'fatal', msg: 'startup failed', error: expect.stringMatching(/row level security/) });
    expect(service.output()).not.toMatch(/UnhandledPromiseRejection/);
  });
});

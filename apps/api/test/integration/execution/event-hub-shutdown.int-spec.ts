import { ApiConfig } from '../../../src/config/config';
import { ExecutionEventsHub } from '../../../src/executions/execution-events.hub';
import { useIntegrationContext } from '../../support/context';

describe('execution event listener shutdown', () => {
  const ctx = useIntegrationContext();

  it('does not keep listening when the application stops while the connection is being opened', async () => {
    const config = {
      databaseUrl: ctx.db.url,
      databaseTimeouts: { connectTimeoutMs: 5_000 },
      executionEventsPingMs: 60_000,
    } as unknown as ApiConfig;
    const hub = new ExecutionEventsHub(config);

    hub.onApplicationBootstrap();
    await hub.onApplicationShutdown();
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(hub.isListening).toBe(false);
    const [{ listeners }]: Array<{ listeners: number }> = await ctx.ds.query(
      `SELECT count(*)::int AS listeners FROM pg_stat_activity WHERE datname = current_database() AND query LIKE 'LISTEN %'`,
    );
    expect(listeners).toBe(0);
  });
});

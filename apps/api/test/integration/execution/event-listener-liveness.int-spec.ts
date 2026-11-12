import { createConnection, createServer, Server, Socket } from 'net';
import { AddressInfo } from 'net';
import { ApiConfig } from '../../../src/config/config';
import { ExecutionEventsHub } from '../../../src/executions/execution-events.hub';
import { EXECUTION_EVENTS_CHANNEL } from '../../../src/migrations/1794320900000-execution-change-notifications';
import { useIntegrationContext } from '../../support/context';
import { eventually } from '../../support/eventually';

interface FreezingProxy {
  readonly port: number;
  freeze(): void;
  close(): Promise<void>;
}

async function startFreezingProxy(target: URL): Promise<FreezingProxy> {
  const frozen = new Set<Socket>();
  const open = new Set<Socket>();
  const server: Server = createServer((client) => {
    const upstream = createConnection({ host: target.hostname === 'localhost' ? '127.0.0.1' : target.hostname, port: Number(target.port || 5432) });
    for (const socket of [client, upstream]) {
      open.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => open.delete(socket));
    }
    client.on('data', (chunk) => {
      if (!frozen.has(client)) upstream.write(chunk);
    });
    upstream.on('data', (chunk) => {
      if (!frozen.has(client)) client.write(chunk);
    });
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    freeze() {
      for (const socket of open) frozen.add(socket);
    },
    close: async () => {
      for (const socket of open) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('the listener for execution changes', () => {
  const ctx = useIntegrationContext();
  let proxy: FreezingProxy;
  let hub: ExecutionEventsHub;

  beforeAll(async () => {
    const url = new URL(ctx.db.url);
    proxy = await startFreezingProxy(new URL(ctx.db.url));
    url.hostname = '127.0.0.1';
    url.port = String(proxy.port);
    hub = new ExecutionEventsHub({
      databaseUrl: url.toString(),
      databaseTimeouts: { connectTimeoutMs: 500, statementTimeoutMs: 500 },
      executionEventsPingMs: 300,
    } as ApiConfig);
    hub.onApplicationBootstrap();
  });

  afterAll(async () => {
    await hub?.onApplicationShutdown();
    await proxy?.close();
  });

  it('notices a connection that stopped answering and listens again on a new one', async () => {
    const received: string[] = [];
    const id = '5d1f8d1e-3c1a-4f7e-9a51-2f9c5c1a0b11';
    hub.subscribe(id, () => received.push(id));
    await eventually(() => expect(hub.isListening).toBe(true));

    received.length = 0;
    proxy.freeze();

    await eventually(
      async () => {
        await ctx.ds.query('SELECT pg_notify($1, $2)', [EXECUTION_EVENTS_CHANNEL, id]);
        expect(received.length).toBeGreaterThan(1);
      },
      { timeoutMs: 10_000, intervalMs: 300 },
    );
    expect(hub.isListening).toBe(true);
  });
});

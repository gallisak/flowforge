import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { registry } from './metrics';

export type ReadinessCheck = () => Promise<boolean>;

export interface OpsServer {
  readonly port: number;
  markShuttingDown(): void;
  close(): Promise<void>;
}

const READINESS_TIMEOUT_MS = 2_000;

async function isReady(check: ReadinessCheck): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), READINESS_TIMEOUT_MS);
  });
  try {
    return await Promise.race([check().catch(() => false), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

export async function startOpsServer(port: number, readiness: ReadinessCheck): Promise<OpsServer> {
  let shuttingDown = false;
  const server: Server = createServer((req, res) => {
    const reply = (status: number, contentType: string, body: string) => {
      res.writeHead(status, { 'content-type': contentType }).end(body);
    };
    const path = (req.url ?? '/').split('?')[0];
    if (req.method !== 'GET') return reply(405, 'text/plain', 'method not allowed');
    if (path === '/health/live') return reply(200, 'application/json', '{"status":"ok"}');
    if (path === '/health/ready') {
      if (shuttingDown) return reply(503, 'application/json', '{"status":"shutting down"}');
      void isReady(readiness).then((ready) =>
        reply(ready ? 200 : 503, 'application/json', ready ? '{"status":"ready"}' : '{"status":"not ready"}'),
      );
      return;
    }
    if (path === '/metrics') {
      registry.metrics().then(
        (text) => reply(200, registry.contentType, text),
        () => reply(500, 'text/plain', 'metrics are unavailable'),
      );
      return;
    }
    reply(404, 'text/plain', 'not found');
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  return {
    port: (server.address() as AddressInfo).port,
    markShuttingDown() {
      shuttingDown = true;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

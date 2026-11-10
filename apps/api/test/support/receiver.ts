import { createServer, IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  receivedAt: number;
}

export type ReceiverHandler = (req: RecordedRequest, res: ServerResponse) => void | Promise<void>;

export interface Receiver {
  readonly url: string;
  readonly requests: RecordedRequest[];
  setHandler(handler: ReceiverHandler): void;
  close(): Promise<void>;
}

const defaultHandler: ReceiverHandler = (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
};

export async function startReceiver(handler: ReceiverHandler = defaultHandler): Promise<Receiver> {
  const requests: RecordedRequest[] = [];
  let current = handler;
  const open = new Set<ServerResponse>();

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const recorded: RecordedRequest = {
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        receivedAt: Date.now(),
      };
      requests.push(recorded);
      open.add(res);
      res.on('close', () => open.delete(res));
      Promise.resolve(current(recorded, res)).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setHandler(h) {
      current = h;
    },
    async close() {
      for (const res of open) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { startOpsServer } from '../src/observability/ops-server';

describe('ops server', () => {
  let occupied: Server;

  beforeAll(async () => {
    occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  });

  it('reports a port that is already in use as a failed start instead of an uncaught exception', async () => {
    const port = (occupied.address() as AddressInfo).port;

    await expect(startOpsServer(port, async () => true)).rejects.toThrow(/EADDRINUSE/);
  });
});

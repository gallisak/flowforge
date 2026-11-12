import { EventEmitter } from 'events';
import { Writable } from 'stream';
import { Request, Response } from 'express';
import { ApiConfig } from '../src/config/config';
import { ExecutionEventsHub } from '../src/executions/execution-events.hub';
import { ExecutionStreamService } from '../src/executions/execution-stream.service';
import { ExecutionsService } from '../src/executions/executions.service';

const TENANT = '9f1c2c4e-1d0a-4f37-9c55-0f3f1c1b2a10';
const EXECUTION = '1a2b3c4d-1d0a-4f37-9c55-0f3f1c1b2a10';

class FakeHub {
  private readonly listeners = new Map<string, Set<() => void>>();

  subscribe(executionId: string, listener: () => void): () => void {
    const set = this.listeners.get(executionId) ?? new Set();
    set.add(listener);
    this.listeners.set(executionId, set);
    return () => set.delete(listener);
  }

  change(executionId: string): void {
    for (const listener of [...(this.listeners.get(executionId) ?? [])]) listener();
  }

  get listenerCount(): number {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }
}

class FakeResponse extends Writable {
  status = 0;
  accepted = 0;

  constructor(private readonly reads: boolean) {
    super({ highWaterMark: 1024 });
  }

  writeHead(status: number): this {
    this.status = status;
    return this;
  }

  _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.accepted += chunk.length;
    if (this.reads) done();
  }
}

function fakeRequest(): Request {
  return Object.assign(new EventEmitter(), { socket: { destroyed: false } }) as unknown as Request;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 70));

describe('execution stream service', () => {
  let hub: FakeHub;
  let reads: number;
  let snapshot: Record<string, unknown>;
  let service: ExecutionStreamService;

  beforeEach(() => {
    hub = new FakeHub();
    reads = 0;
    snapshot = { id: EXECUTION, status: 'running', steps: [], padding: 'x'.repeat(4096) };
    const executions = {
      watch: async () => undefined,
      get: async () => {
        reads++;
        return { ...snapshot };
      },
    } as unknown as ExecutionsService;
    service = new ExecutionStreamService(hub as unknown as ExecutionEventsHub, executions, { executionStreamsPerTenant: 20 } as ApiConfig);
  });

  afterEach(() => service.beforeApplicationShutdown());

  it('reads a changed execution once for all of its open streams', async () => {
    const streams = [new FakeResponse(true), new FakeResponse(true), new FakeResponse(true)];
    for (const res of streams) await service.stream(TENANT, EXECUTION, fakeRequest(), res as unknown as Response);
    const initialReads = reads;

    hub.change(EXECUTION);
    await settle();

    expect(initialReads).toBe(3);
    expect(reads - initialReads).toBe(1);
    expect(hub.listenerCount).toBe(1);
  });

  it('keeps only the latest snapshot for a client that stops reading', async () => {
    const stalled = new FakeResponse(false);
    await service.stream(TENANT, EXECUTION, fakeRequest(), stalled as unknown as Response);

    for (let i = 0; i < 20; i++) {
      snapshot = { ...snapshot, error: `change ${i}` };
      hub.change(EXECUTION);
      await settle();
    }

    expect(stalled.writableLength).toBeLessThan(3 * 5_000);
  });

  it('closes a stream whose client stopped reading once its buffer is over the limit', async () => {
    const stalled = new FakeResponse(false);
    snapshot = { ...snapshot, padding: 'x'.repeat(3 * 1024 * 1024) };
    await service.stream(TENANT, EXECUTION, fakeRequest(), stalled as unknown as Response);

    expect(stalled.destroyed).toBe(true);
    expect(hub.listenerCount).toBe(0);
  });
});

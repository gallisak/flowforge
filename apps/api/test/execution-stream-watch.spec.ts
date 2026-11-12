import { EventEmitter } from 'events';
import { Writable } from 'stream';
import { Request, Response } from 'express';
import { ApiConfig } from '../src/config/config';
import { ExecutionEventsHub } from '../src/executions/execution-events.hub';
import { ExecutionStreamService } from '../src/executions/execution-stream.service';
import { ExecutionsService } from '../src/executions/executions.service';

const TENANT = '9f1c2c4e-1d0a-4f37-9c55-0f3f1c1b2a10';
const EXECUTION = '1a2b3c4d-1d0a-4f37-9c55-0f3f1c1b2a10';
const WATCH_RENEW_MS = 60_000;

class CollectingResponse extends Writable {
  text = '';

  writeHead(): this {
    return this;
  }

  _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.text += chunk.toString();
    done();
  }
}

function fakeRequest(): Request {
  return Object.assign(new EventEmitter(), { socket: { destroyed: false } }) as unknown as Request;
}

describe('execution stream when renewing the watch fails', () => {
  let status: string;
  let watchFails: boolean;
  let service: ExecutionStreamService;

  beforeEach(() => {
    jest.useFakeTimers();
    status = 'running';
    watchFails = false;
    const executions = {
      watch: async () => {
        if (watchFails) throw new Error('connection terminated');
      },
      get: async () => ({ id: EXECUTION, status, steps: [] }),
    } as unknown as ExecutionsService;
    const hub = { subscribe: () => () => undefined } as unknown as ExecutionEventsHub;
    service = new ExecutionStreamService(hub, executions, { executionStreamsPerTenant: 20 } as ApiConfig);
  });

  afterEach(() => {
    service.beforeApplicationShutdown();
    jest.useRealTimers();
  });

  it('catches up with changes it was not notified about once the watch is back and sends the final snapshot', async () => {
    const res = new CollectingResponse();
    await service.stream(TENANT, EXECUTION, fakeRequest(), res as unknown as Response);
    await jest.advanceTimersByTimeAsync(2_000);

    watchFails = true;
    await jest.advanceTimersByTimeAsync(2 * WATCH_RENEW_MS + 1_000);
    status = 'succeeded';
    watchFails = false;
    await jest.advanceTimersByTimeAsync(WATCH_RENEW_MS + 1_000);

    expect(res.text).toContain('"status":"succeeded"');
    expect(res.writableEnded).toBe(true);
  });
});

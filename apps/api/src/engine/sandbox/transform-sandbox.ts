import { Worker } from 'worker_threads';
import { SANDBOX_THREAD_SOURCE, SandboxReply, SandboxRequest } from './sandbox-thread';

export interface SandboxLimits {
  timeoutMs: number;
  memoryBytes: number;
  stackBytes: number;
}

export class TransformError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export const SANDBOX_STACK_BYTES = 48 * 1024;
const THREAD_START_TIMEOUT_MS = 10_000;
const THREAD_HEAP_MB = 64;

interface Pending {
  resolve(reply: SandboxReply): void;
  reject(error: Error): void;
}

class SandboxThread {
  private readonly worker: Worker;
  readonly ready: Promise<void>;
  private pending?: Pending;
  private exited = false;
  private retired = false;

  constructor(onExit: (thread: SandboxThread) => void) {
    this.worker = new Worker(SANDBOX_THREAD_SOURCE, {
      eval: true,
      workerData: { quickjsPath: require.resolve('quickjs-emscripten') },
      resourceLimits: { maxOldGenerationSizeMb: THREAD_HEAP_MB, maxYoungGenerationSizeMb: 16 },
      stdout: true,
      stderr: true,
    });
    this.worker.unref();
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new TransformError('transform sandbox did not start in time', true)), THREAD_START_TIMEOUT_MS);
      this.worker.once('message', (message: SandboxReply | { ready: true }) => {
        clearTimeout(timer);
        if ('ready' in message) resolve();
        else reject(new TransformError('transform sandbox failed to start', true));
      });
      this.worker.once('exit', () => {
        clearTimeout(timer);
        reject(new TransformError('transform sandbox failed to start', true));
      });
    });
    this.ready.catch(() => undefined);
    this.worker.on('error', () => undefined);
    this.worker.on('exit', () => {
      this.exited = true;
      this.pending?.reject(new TransformError('transform sandbox crashed'));
      this.pending = undefined;
      onExit(this);
    });
  }

  get alive(): boolean {
    return !this.exited && !this.retired;
  }

  async run(request: SandboxRequest, hardTimeoutMs: number): Promise<SandboxReply> {
    try {
      await this.ready;
    } catch (error) {
      await this.terminate();
      throw error;
    }
    return new Promise<SandboxReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        void this.terminate();
        reject(new TransformError(`transform timed out after ${request.limits.timeoutMs} ms`));
      }, hardTimeoutMs);
      const settle = () => {
        clearTimeout(timer);
        this.pending = undefined;
        this.worker.off('message', onMessage);
      };
      const onMessage = (reply: SandboxReply) => {
        settle();
        resolve(reply);
      };
      this.pending = {
        resolve: onMessage,
        reject: (error) => {
          settle();
          reject(error);
        },
      };
      this.worker.on('message', onMessage);
      this.worker.postMessage(request);
    });
  }

  async terminate(): Promise<void> {
    this.retired = true;
    if (this.exited) return;
    await this.worker.terminate();
  }
}

export class TransformSandbox {
  private readonly idle: SandboxThread[] = [];
  private readonly all = new Set<SandboxThread>();
  private readonly waiters: Array<{ resolve(thread: SandboxThread): void; reject(error: Error): void }> = [];
  private closed = false;

  constructor(
    private readonly limits: SandboxLimits,
    private readonly maxThreads: number,
  ) {}

  async evaluate(expr: string, input: unknown): Promise<unknown> {
    const thread = await this.acquire();
    try {
      const reply = await thread.run(
        { expr, input: JSON.stringify(input), limits: this.limits },
        this.limits.timeoutMs + Math.max(250, this.limits.timeoutMs),
      );
      if ('error' in reply) throw new TransformError(reply.error);
      return reply.output === undefined ? undefined : JSON.parse(reply.output);
    } finally {
      this.release(thread);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(new TransformError('transform sandbox is shut down', true));
    await Promise.all([...this.all].map((thread) => thread.terminate()));
  }

  private acquire(): Promise<SandboxThread> {
    if (this.closed) return Promise.reject(new TransformError('transform sandbox is shut down', true));
    const thread = this.idle.pop();
    if (thread) return Promise.resolve(thread);
    if (this.all.size < this.maxThreads) {
      const created = new SandboxThread((exited) => this.forget(exited));
      this.all.add(created);
      return Promise.resolve(created);
    }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private release(thread: SandboxThread): void {
    if (!thread.alive || this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(thread);
    else this.idle.push(thread);
  }

  private forget(thread: SandboxThread): void {
    this.all.delete(thread);
    const index = this.idle.indexOf(thread);
    if (index >= 0) this.idle.splice(index, 1);
    const waiter = this.waiters.shift();
    if (waiter && !this.closed) {
      const replacement = new SandboxThread((exited) => this.forget(exited));
      this.all.add(replacement);
      waiter.resolve(replacement);
    }
  }
}

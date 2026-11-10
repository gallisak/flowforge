import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ChildProcess, spawn } from 'child_process';
import { join } from 'path';
import { WorkerModule } from '../../src/app.module';
import { JobRunnerService } from '../../src/engine/job-runner.service';

const API_ROOT = join(__dirname, '..', '..');

export interface InProcessWorkers {
  readonly ids: string[];
  stop(): Promise<void>;
}

export async function startInProcessWorkers(count: number, concurrency = 1): Promise<InProcessWorkers> {
  const contexts: INestApplicationContext[] = [];
  for (let i = 0; i < count; i++) {
    const ctx = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error'] });
    ctx.get(JobRunnerService).start(concurrency);
    contexts.push(ctx);
  }
  return {
    ids: contexts.map((c) => c.get(JobRunnerService).workerId),
    async stop() {
      for (const c of contexts) c.get(JobRunnerService).onApplicationShutdown();
      await new Promise((r) => setTimeout(r, 400));
      await Promise.all(contexts.map((c) => c.close()));
    },
  };
}

export interface WorkerProcess {
  readonly child: ChildProcess;
  output(): string;
  waitForOutput(pattern: RegExp, timeoutMs?: number): Promise<void>;
  kill(signal?: NodeJS.Signals): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export function spawnWorkerProcess(env: Record<string, string> = {}): WorkerProcess {
  const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', join(API_ROOT, 'src', 'worker.ts')], {
    cwd: API_ROOT,
    env: {
      ...process.env,
      TS_NODE_PROJECT: join(API_ROOT, 'tsconfig.json'),
      NO_COLOR: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let buffer = '';
  const onData = (chunk: Buffer) => {
    buffer += chunk.toString();
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  return {
    child,
    output: () => buffer,
    waitForOutput(pattern, timeoutMs = 30_000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          if (pattern.test(buffer)) {
            cleanup();
            resolve();
          }
        };
        const onExit = () => {
          cleanup();
          reject(new Error(`Worker process exited before ${pattern} appeared:\n${buffer}`));
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out after ${timeoutMs} ms waiting for ${pattern}:\n${buffer}`));
        }, timeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          child.stdout?.off('data', check);
          child.stderr?.off('data', check);
          child.off('exit', onExit);
        };
        child.stdout?.on('data', check);
        child.stderr?.on('data', check);
        child.once('exit', onExit);
        check();
      });
    },
    async kill(signal = 'SIGKILL') {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      return exited;
    },
  };
}

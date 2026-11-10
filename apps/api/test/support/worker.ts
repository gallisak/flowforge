import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from '../../src/app.module';
import { JobRunnerService } from '../../src/engine/job-runner.service';
import { AppProcess, spawnAppProcess } from './process';

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

export type WorkerProcess = AppProcess;

export function spawnWorkerProcess(env: Record<string, string> = {}): WorkerProcess {
  return spawnAppProcess('worker', env);
}

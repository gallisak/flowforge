import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { SchedulerModule } from '../../src/app.module';
import { SchedulerService } from '../../src/scheduler/scheduler.service';

export interface InProcessSchedulers {
  readonly services: SchedulerService[];
  stop(): Promise<void>;
}

export async function startInProcessSchedulers(count: number): Promise<InProcessSchedulers> {
  const contexts: INestApplicationContext[] = [];
  for (let i = 0; i < count; i++) {
    contexts.push(await NestFactory.createApplicationContext(SchedulerModule, { logger: ['error'] }));
  }
  return {
    services: contexts.map((c) => c.get(SchedulerService)),
    async stop() {
      await Promise.all(contexts.map((c) => c.close()));
    },
  };
}

export async function createScheduledWorkflow(
  app: INestApplication,
  apiKey: string,
  schedule: Record<string, unknown>,
): Promise<{ id: string }> {
  const response = await request(app.getHttpServer())
    .post('/workflows')
    .set('x-api-key', apiKey)
    .send({ name: 'scheduled', steps: [{ id: 'note', type: 'log', message: 'tick' }], ...schedule })
    .expect(201);
  return response.body;
}

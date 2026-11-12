import { NestFactory } from '@nestjs/core';
import { SchedulerModule, WorkerModule } from '../../../src/app.module';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';

describe('services refuse a database role that bypasses row level security', () => {
  const ctx = useIntegrationContext();
  let appUrl: string;

  beforeAll(() => {
    appUrl = process.env.DATABASE_URL as string;
  });

  afterEach(() => {
    process.env.DATABASE_URL = appUrl;
  });

  const refusal = /must not own the tables, be a superuser or bypass row level security/;

  it.each([
    ['the owner of the tables', () => ctx.db.ownerUrl],
    ['a superuser', () => ctx.db.adminUrl],
  ])('the API does not start as %s', async (_role, url) => {
    process.env.DATABASE_URL = url();

    await expect(createTestApp()).rejects.toThrow(refusal);
  });

  it('the worker and the scheduler do not start as the owner of the tables', async () => {
    process.env.DATABASE_URL = ctx.db.ownerUrl;

    await expect(NestFactory.createApplicationContext(WorkerModule, { logger: false, abortOnError: false })).rejects.toThrow(refusal);
    await expect(NestFactory.createApplicationContext(SchedulerModule, { logger: false, abortOnError: false })).rejects.toThrow(refusal);
  });

  it('the API starts as the application role', async () => {
    const app = await createTestApp();
    await app.close();
  });
});

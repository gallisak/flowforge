import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant } from '../../support/db';

describe('database timeouts', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  const previous = process.env.DB_STATEMENT_TIMEOUT_MS;

  beforeAll(async () => {
    process.env.DB_STATEMENT_TIMEOUT_MS = '500';
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
    if (previous === undefined) delete process.env.DB_STATEMENT_TIMEOUT_MS;
    else process.env.DB_STATEMENT_TIMEOUT_MS = previous;
  });

  it('cancels a statement that runs longer than DB_STATEMENT_TIMEOUT_MS', async () => {
    const started = Date.now();
    await expect(app.get(DataSource).query('SELECT pg_sleep(5)')).rejects.toThrow(/statement timeout/);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('keeps serving requests after a statement was cancelled', async () => {
    const { apiKey } = await seedTenant(ctx.ds, 'after-timeout');
    await request(app.getHttpServer()).get('/workflows').set('x-api-key', apiKey).expect(200);
  });
});

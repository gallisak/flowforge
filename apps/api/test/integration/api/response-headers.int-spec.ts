import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant } from '../../support/db';

describe('headers of API responses', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let tenant: SeededTenant;

  beforeAll(async () => {
    app = await createTestApp();
    tenant = await seedTenant(ctx.ds, 'headers');
  });

  afterAll(async () => {
    await app?.close();
  });

  it.each([
    ['tenant data', () => request(app.getHttpServer()).get('/workflows').set('x-api-key', tenant.apiKey), 200],
    ['an error', () => request(app.getHttpServer()).get('/workflows'), 401],
    ['an unsupported body', () => request(app.getHttpServer()).post('/workflows').set('content-type', 'text/plain').send('x'), 415],
  ] as const)('keep %s out of shared caches and do not name the framework', async (_case, send, status) => {
    const res = await send().expect(status);

    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

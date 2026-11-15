import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant } from '../../support/db';

describe('notification endpoints on an allowlisted host', () => {
  const ctx = useIntegrationContext();
  const saved = { ...process.env };
  let app: INestApplication;
  let tenant: SeededTenant;

  beforeAll(async () => {
    process.env.SSRF_ALLOWLIST = 'localhost.';
    app = await createTestApp();
    tenant = await seedTenant(ctx.ds, 'allowlisted-endpoint');
  });

  afterAll(async () => {
    await app?.close();
    process.env = saved;
  });

  it('matches an allowlist entry written with a trailing dot, as http steps do', async () => {
    const res = await request(app.getHttpServer())
      .put('/notifications/endpoint')
      .set('x-api-key', tenant.apiKey)
      .send({ url: 'http://localhost:18080/notify' })
      .expect(200);

    expect(res.body.url).toBe('http://localhost:18080/notify');
  });
});

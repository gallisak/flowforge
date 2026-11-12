import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant } from '../../support/db';

describe('notification endpoint urls the URL parser refuses', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let tenant: SeededTenant;

  beforeAll(async () => {
    app = await createTestApp();
    tenant = await seedTenant(ctx.ds, 'endpoint-urls');
  });

  afterAll(async () => {
    await app?.close();
  });

  it.each(['https://[fe80::1%25eth0]/x', 'https://[fe80::1%eth0]/x'])('answers 400 for %s', async (url) => {
    const res = await request(app.getHttpServer()).put('/notifications/endpoint').set('x-api-key', tenant.apiKey).send({ url }).expect(400);

    expect(res.body.message).toBe('url is invalid');
  });
});

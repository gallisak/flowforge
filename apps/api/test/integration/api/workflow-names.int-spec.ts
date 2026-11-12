import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant } from '../../support/db';

describe('workflow names', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let tenant: SeededTenant;
  const steps = [{ id: 'note', type: 'log', message: 'hi' }];

  beforeAll(async () => {
    app = await createTestApp();
    tenant = await seedTenant(ctx.ds, 'names');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('refuses a name of only spaces, which the UI could not edit', async () => {
    await request(app.getHttpServer()).post('/workflows').set('x-api-key', tenant.apiKey).send({ name: '   ', steps }).expect(400);
    const created = await request(app.getHttpServer()).post('/workflows').set('x-api-key', tenant.apiKey).send({ name: 'ok', steps }).expect(201);
    await request(app.getHttpServer()).patch(`/workflows/${created.body.id}`).set('x-api-key', tenant.apiKey).send({ name: ' \t ' }).expect(400);
  });
});

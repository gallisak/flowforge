import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';

describe('tenant names', () => {
  useIntegrationContext();
  let app: INestApplication;
  const create = (name: string) =>
    request(app.getHttpServer()).post('/tenants').set('x-admin-token', process.env.ADMIN_TOKEN ?? '').send({ name });

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('refuses a name of only spaces', async () => {
    const res = await create('   ').expect(400);

    expect(res.body).toEqual({ statusCode: 400, message: ['name must not be blank'], error: 'Bad Request' });
    await create('acme').expect(201);
  });

  it('answers a wrong admin token with the common error shape', async () => {
    const res = await request(app.getHttpServer()).post('/tenants').set('x-admin-token', 'wrong').send({ name: 'acme' }).expect(403);

    expect(res.body).toEqual({ statusCode: 403, message: 'Missing or invalid x-admin-token', error: 'Forbidden' });
  });
});

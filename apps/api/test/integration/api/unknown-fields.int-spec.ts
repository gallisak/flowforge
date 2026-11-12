import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant } from '../../support/db';

describe('request bodies with fields the API does not know', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let tenant: SeededTenant;
  const steps = [{ id: 'note', type: 'log', message: 'hi' }];
  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    tenant = await seedTenant(ctx.ds, 'unknown-fields');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('refuses a misspelled field instead of answering 200 and changing nothing', async () => {
    const created = await api().post('/workflows').set('x-api-key', tenant.apiKey).send({ name: 'typo', steps }).expect(201);

    const res = await api().patch(`/workflows/${created.body.id}`).set('x-api-key', tenant.apiKey).send({ enable: false }).expect(400);

    expect(res.body.message).toEqual(expect.arrayContaining(['property enable should not exist']));
    const current = await api().get(`/workflows/${created.body.id}`).set('x-api-key', tenant.apiKey).expect(200);
    expect(current.body.enabled).toBe(true);
  });

  it('refuses unknown fields when creating a workflow', async () => {
    await api().post('/workflows').set('x-api-key', tenant.apiKey).send({ name: 'extra', steps, owner: 'someone' }).expect(400);
  });
});

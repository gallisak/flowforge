import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { REQUEST_BODY_MAX_BYTES } from '../../../src/app.setup';
import { STEP_LIMITS } from '../../../src/workflows/definition';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant } from '../../support/db';

describe('request body size', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let apiKey: string;

  const httpStep = (id: string) => ({ id, type: 'http', method: 'POST', url: 'https://example.com/orders', body: 'a'.repeat(STEP_LIMITS.bodyLength) });

  beforeAll(async () => {
    app = await createTestApp();
    ({ apiKey } = await seedTenant(ctx.ds));
  });

  afterAll(async () => {
    await app?.close();
  });

  it('accepts a workflow whose steps each stay within the documented limits', async () => {
    const steps = ['one', 'two', 'three'].map(httpStep);

    await request(app.getHttpServer()).post('/workflows').set('x-api-key', apiKey).send({ name: 'large', steps }).expect(201);
  });

  it('refuses a request body above the documented request limit', async () => {
    const name = 'a'.repeat(REQUEST_BODY_MAX_BYTES);

    await request(app.getHttpServer()).post('/workflows').set('x-api-key', apiKey).send({ name, steps: [] }).expect(413);
  });
});

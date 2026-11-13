import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Workflow } from '../../../src/entities';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant } from '../../support/db';

const STEPS = [{ id: 'note', type: 'log', message: 'hi' }];

describe('request body encodings', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let tenant: SeededTenant;

  const post = (path: string, contentType: string, body: string | Buffer) =>
    request(app.getHttpServer()).post(path).set('x-api-key', tenant.apiKey).set('content-type', contentType).send(body);

  beforeAll(async () => {
    app = await createTestApp();
    tenant = await seedTenant(ctx.ds, 'encodings');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('refuses a form-encoded body instead of storing what it decodes to', async () => {
    const response = await post('/workflows', 'application/x-www-form-urlencoded', 'name=x%00&steps[0][id]=s&steps[0][type]=log&steps[0][message]=m');

    expect(response.status).toBe(415);
    expect(await ctx.ds.getRepository(Workflow).countBy({ tenantId: tenant.tenant.id })).toBe(0);
  });

  it('refuses a JSON body in an encoding other than UTF-8, so that the depth check reads the same characters as the parser', async () => {
    const deep = `{"k":"䄢","x":${'['.repeat(100)}${']'.repeat(100)}}`;
    const response = await post('/workflows/00000000-0000-4000-8000-000000000000/run', 'application/json; charset=utf-16le', Buffer.from(deep, 'utf16le'));

    expect(response.status).toBe(415);
  });

  it('refuses a body whose content type is not JSON', async () => {
    const response = await post('/workflows', 'text/plain', JSON.stringify({ name: 'plain', steps: STEPS }));

    expect(response.status).toBe(415);
    expect(response.body).toEqual({ statusCode: 415, message: 'Request body must be application/json in UTF-8', error: 'Unsupported Media Type' });
  });

  it('accepts JSON with an explicit UTF-8 charset', async () => {
    await post('/workflows', 'application/json; charset=UTF-8', JSON.stringify({ name: 'explicit', steps: STEPS })).expect(201);
  });
});

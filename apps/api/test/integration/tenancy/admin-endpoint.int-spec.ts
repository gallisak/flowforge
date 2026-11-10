import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Tenant } from '../../../src/entities';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';

describe('tenant creation endpoint', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  const adminToken = () => process.env.ADMIN_TOKEN as string;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  const create = (body: unknown, token?: string) => {
    const req = request(app.getHttpServer()).post('/tenants');
    if (token !== undefined) req.set('x-admin-token', token);
    return req.send(body as object);
  };

  it.each([
    ['no admin token and a valid body', undefined, { name: 'acme' }],
    ['no admin token and an invalid body', undefined, { name: 'x' }],
    ['a wrong admin token', 'not-the-admin-token', { name: 'acme' }],
    ['an admin token that differs only in length', `${'x'}`, {}],
  ])('answers 403 with %s, before looking at the body', async (_case, token, body) => {
    const res = await create(body, token);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toMatch(/name/);
  });

  it.each([
    ['a name that is too short', 'x'],
    ['a name longer than 200 characters', 'x'.repeat(201)],
  ])('rejects %s with 400 for an authorised caller', async (_case, name) => {
    await create({ name }, adminToken()).expect(400);
  });

  it('creates a tenant and returns its credentials once', async () => {
    const res = await create({ name: 'n'.repeat(200) }, adminToken()).expect(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      name: 'n'.repeat(200),
      apiKey: expect.stringMatching(/^ff_[0-9a-f]{48}$/),
      webhookSecret: expect.stringMatching(/^[0-9a-f]{48}$/),
    });
    const stored = await ctx.ds.getRepository(Tenant).findOneByOrFail({ id: res.body.id });
    expect(stored.apiKeyHash).not.toBe(res.body.apiKey);
  });
});

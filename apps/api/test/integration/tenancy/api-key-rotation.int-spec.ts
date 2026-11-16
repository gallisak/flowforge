import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant } from '../../support/db';

describe('rotating a tenant API key', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  const adminToken = () => process.env.ADMIN_TOKEN as string;
  const rotate = (tenantId: string, token = adminToken()) => request(app.getHttpServer()).post(`/tenants/${tenantId}/api-key`).set('x-admin-token', token);
  const listWorkflows = (apiKey: string) => request(app.getHttpServer()).get('/workflows').set('x-api-key', apiKey);

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns a new key once and stops accepting the old one at once', async () => {
    const { tenant, apiKey: oldKey } = await seedTenant(ctx.ds, 'rotating');

    const res = await rotate(tenant.id).expect(201);

    expect(res.body).toEqual({ id: tenant.id, apiKey: expect.stringMatching(/^ff_[0-9a-f]{48}$/) });
    await listWorkflows(res.body.apiKey).expect(200);
    await listWorkflows(oldKey).expect(401);
  });

  it('leaves the keys of other tenants working', async () => {
    const rotated = await seedTenant(ctx.ds, 'rotated');
    const other = await seedTenant(ctx.ds, 'untouched');

    await rotate(rotated.tenant.id).expect(201);

    await listWorkflows(other.apiKey).expect(200);
  });

  it('answers 404 for an unknown tenant and 403 without the admin token', async () => {
    await rotate(randomUUID()).expect(404);
    const { tenant, apiKey } = await seedTenant(ctx.ds, 'protected');
    await rotate(tenant.id, 'not-the-admin-token').expect(403);
    await listWorkflows(apiKey).expect(200);
  });
});

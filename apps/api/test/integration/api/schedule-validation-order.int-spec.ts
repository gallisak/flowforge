import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant, seedWorkflow } from '../../support/db';

describe('order of the checks when a workflow is created', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let tenant: SeededTenant;
  const saved = process.env.TENANT_MAX_WORKFLOWS;

  beforeAll(async () => {
    process.env.TENANT_MAX_WORKFLOWS = '1';
    app = await createTestApp();
    tenant = await seedTenant(ctx.ds, 'full-quota');
    await seedWorkflow(ctx.ds, tenant.tenant.id, [{ id: 'note', type: 'log', message: 'hi' }]);
  });

  afterAll(async () => {
    await app?.close();
    if (saved === undefined) delete process.env.TENANT_MAX_WORKFLOWS;
    else process.env.TENANT_MAX_WORKFLOWS = saved;
  });

  it('refuses a tenant at its workflow limit before it evaluates the schedule', async () => {
    const response = await request(app.getHttpServer())
      .post('/workflows')
      .set('x-api-key', tenant.apiKey)
      .send({ name: 'sparse', steps: [{ id: 'note', type: 'log', message: 'hi' }], cron: '0 0 31 2 *', timezone: 'Australia/Lord_Howe' });

    expect(response.status).toBe(403);
  });
});

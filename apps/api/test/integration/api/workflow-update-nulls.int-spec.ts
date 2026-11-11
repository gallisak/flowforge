import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Workflow } from '../../../src/entities';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow, SeededTenant } from '../../support/db';

describe('updating a workflow with null fields', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let tenant: SeededTenant;
  let workflow: Workflow;

  beforeAll(async () => {
    app = await createTestApp();
    tenant = await seedTenant(ctx.ds, 'nulls');
    workflow = await seedWorkflow(ctx.ds, tenant.tenant.id, [{ id: 'hello', type: 'log', message: 'hi' }]);
  });

  afterAll(async () => {
    await app?.close();
  });

  it.each(['name', 'steps', 'timezone', 'enabled', 'missedRunPolicy'])('rejects %s: null with 400 and keeps the workflow', async (field) => {
    const res = await request(app.getHttpServer())
      .patch(`/workflows/${workflow.id}`)
      .set('x-api-key', tenant.apiKey)
      .send({ [field]: null });

    expect(res.status).toBe(400);
    expect(await ctx.ds.getRepository(Workflow).findOneByOrFail({ id: workflow.id })).toMatchObject({
      name: 'test-workflow',
      timezone: 'UTC',
      enabled: true,
      missedRunPolicy: 'once',
    });
  });

  it('still accepts cron: null to remove the schedule', async () => {
    await request(app.getHttpServer())
      .patch(`/workflows/${workflow.id}`)
      .set('x-api-key', tenant.apiKey)
      .send({ cron: null })
      .expect(200);
  });
});

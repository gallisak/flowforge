import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow, SeededTenant } from '../../support/db';

describe('F-01 execution details are isolated per tenant', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let owner: SeededTenant;
  let intruder: SeededTenant;
  let executionId: string;

  beforeAll(async () => {
    app = await createTestApp();
    owner = await seedTenant(ctx.ds, 'owner');
    intruder = await seedTenant(ctx.ds, 'intruder');
    const workflow = await seedWorkflow(ctx.ds, owner.tenant.id, [{ id: 'hello', type: 'log', message: 'hi' }]);
    const run = await request(app.getHttpServer())
      .post(`/workflows/${workflow.id}/run`)
      .set('x-api-key', owner.apiKey)
      .send({ customerToken: 'owner-private-token' })
      .expect(201);
    executionId = run.body.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns the execution to the tenant that owns it', async () => {
    const res = await request(app.getHttpServer())
      .get(`/executions/${executionId}`)
      .set('x-api-key', owner.apiKey)
      .expect(200);
    expect(res.body.input).toEqual({ customerToken: 'owner-private-token' });
  });

  it('answers 404 to another tenant without revealing anything about the execution', async () => {
    const res = await request(app.getHttpServer()).get(`/executions/${executionId}`).set('x-api-key', intruder.apiKey);

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('owner-private-token');
    expect(JSON.stringify(res.body)).not.toContain(owner.tenant.id);
  });

  it('answers the same 404 for an execution that does not exist', async () => {
    const foreign = await request(app.getHttpServer()).get(`/executions/${executionId}`).set('x-api-key', intruder.apiKey);
    const missing = await request(app.getHttpServer()).get(`/executions/${randomUUID()}`).set('x-api-key', intruder.apiKey);

    expect(foreign.status).toBe(missing.status);
    expect(foreign.body).toEqual(missing.body);
  });
});

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Execution, Workflow } from '../../../src/entities';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow, SeededTenant } from '../../support/db';

describe('tenant B cannot read or change tenant A data through the API', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let owner: SeededTenant;
  let intruder: SeededTenant;
  let workflow: Workflow;

  beforeAll(async () => {
    app = await createTestApp();
    owner = await seedTenant(ctx.ds, 'owner');
    intruder = await seedTenant(ctx.ds, 'intruder');
    workflow = await seedWorkflow(ctx.ds, owner.tenant.id, [{ id: 'hello', type: 'log', message: 'hi' }]);
  });

  afterAll(async () => {
    await app?.close();
  });

  const server = () => app.getHttpServer();

  it('does not list workflows of another tenant', async () => {
    const res = await request(server()).get('/workflows').set('x-api-key', intruder.apiKey).expect(200);
    expect(res.body).toEqual([]);
  });

  it('answers 404 when reading a workflow of another tenant', async () => {
    await request(server()).get(`/workflows/${workflow.id}`).set('x-api-key', intruder.apiKey).expect(404);
  });

  it('cannot update a workflow of another tenant', async () => {
    await request(server())
      .patch(`/workflows/${workflow.id}`)
      .set('x-api-key', intruder.apiKey)
      .send({ name: 'hijacked', enabled: false })
      .expect(404);

    const stored = await ctx.ds.getRepository(Workflow).findOneByOrFail({ id: workflow.id });
    expect(stored).toMatchObject({ name: 'test-workflow', enabled: true });
  });

  it('cannot run a workflow of another tenant', async () => {
    await request(server()).post(`/workflows/${workflow.id}/run`).set('x-api-key', intruder.apiKey).send({}).expect(404);
    expect(await ctx.ds.getRepository(Execution).countBy({ workflowId: workflow.id })).toBe(0);
  });

  it('cannot delete a workflow of another tenant', async () => {
    await request(server()).delete(`/workflows/${workflow.id}`).set('x-api-key', intruder.apiKey).expect(404);
    expect(await ctx.ds.getRepository(Workflow).countBy({ id: workflow.id })).toBe(1);
  });
});

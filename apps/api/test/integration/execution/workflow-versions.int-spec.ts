import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { WorkflowVersion } from '../../../src/entities';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant } from '../../support/db';

describe('workflow versions', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let tenant: SeededTenant;
  const step = (message: string) => [{ id: 'note', type: 'log', message }];

  beforeAll(async () => {
    app = await createTestApp();
    tenant = await seedTenant(ctx.ds, 'versions');
  });

  afterAll(async () => {
    await app?.close();
  });

  const server = () => app.getHttpServer();

  it('stores an immutable snapshot for every change of the steps', async () => {
    const created = await request(server()).post('/workflows').set('x-api-key', tenant.apiKey).send({ name: 'wf', steps: step('v1') }).expect(201);
    await request(server()).patch(`/workflows/${created.body.id}`).set('x-api-key', tenant.apiKey).send({ steps: step('v2') }).expect(200);
    await request(server()).patch(`/workflows/${created.body.id}`).set('x-api-key', tenant.apiKey).send({ name: 'renamed' }).expect(200);

    const versions = await ctx.ds.getRepository(WorkflowVersion).find({ where: { workflowId: created.body.id }, order: { version: 'ASC' } });
    expect(versions.map((v) => [v.version, v.steps[0]])).toEqual([
      [1, { id: 'note', type: 'log', message: 'v1' }],
      [2, { id: 'note', type: 'log', message: 'v2' }],
    ]);
  });

  it('records the version that is current when an execution is enqueued', async () => {
    const created = await request(server()).post('/workflows').set('x-api-key', tenant.apiKey).send({ name: 'wf', steps: step('v1') }).expect(201);
    await request(server()).patch(`/workflows/${created.body.id}`).set('x-api-key', tenant.apiKey).send({ steps: step('v2') }).expect(200);

    const run = await request(server()).post(`/workflows/${created.body.id}/run`).set('x-api-key', tenant.apiKey).send({}).expect(201);

    expect(run.body.workflowVersion).toBe(2);
  });

  it('gives concurrent edits distinct versions instead of failing', async () => {
    const created = await request(server()).post('/workflows').set('x-api-key', tenant.apiKey).send({ name: 'wf', steps: step('v1') }).expect(201);

    const edits = await Promise.all(
      ['a', 'b', 'c', 'd'].map((m) =>
        request(server()).patch(`/workflows/${created.body.id}`).set('x-api-key', tenant.apiKey).send({ steps: step(m) }),
      ),
    );

    expect(edits.map((e) => e.status)).toEqual([200, 200, 200, 200]);
    expect(edits.map((e) => e.body.version).sort()).toEqual([2, 3, 4, 5]);
  });
});

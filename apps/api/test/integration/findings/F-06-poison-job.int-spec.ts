import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Execution, Job } from '../../../src/entities';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

describe('F-06 a job that cannot be processed fails instead of hanging', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let workers: InProcessWorkers | undefined;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await workers?.stop();
    await app?.close();
  });

  it('fails the execution when its workflow was deleted before a worker picked it up', async () => {
    const { tenant, apiKey } = await seedTenant(ctx.ds, 'deletes-workflows');
    const workflow = await seedWorkflow(ctx.ds, tenant.id, [{ id: 'hello', type: 'log', message: 'hi' }]);
    const run = await request(app.getHttpServer())
      .post(`/workflows/${workflow.id}/run`)
      .set('x-api-key', apiKey)
      .send({})
      .expect(201);
    await request(app.getHttpServer()).delete(`/workflows/${workflow.id}`).set('x-api-key', apiKey).expect(204);

    workers = await startInProcessWorkers(1);

    await eventually(async () => {
      expect(await ctx.ds.getRepository(Execution).findOneByOrFail({ id: run.body.id })).toMatchObject({
        status: 'failed',
        error: expect.stringMatching(/workflow/i),
      });
      expect(await ctx.ds.getRepository(Job).findOneByOrFail({ executionId: run.body.id })).toMatchObject({
        status: 'failed',
        lockedBy: null,
      });
    });
  });
});

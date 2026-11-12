import { INestApplication } from '@nestjs/common';
import { AddressInfo } from 'net';
import request from 'supertest';
import { Execution } from '../../../src/entities';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant } from '../../support/db';
import { eventually } from '../../support/eventually';
import { openEventStream } from '../../support/sse';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

describe('large step outputs in execution details', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let workers: InProcessWorkers;
  let tenant: SeededTenant;
  let other: SeededTenant;
  let executionId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0, '127.0.0.1');
    tenant = await seedTenant(ctx.ds, 'large-outputs');
    other = await seedTenant(ctx.ds, 'someone-else');
    workers = await startInProcessWorkers(1);
    const workflow = await request(app.getHttpServer())
      .post('/workflows')
      .set('x-api-key', tenant.apiKey)
      .send({
        name: 'large',
        steps: [
          { id: 'big', type: 'transform', expr: '"x".repeat(100000)' },
          { id: 'small', type: 'transform', expr: '({ size: ctx.steps.big.length })' },
          { id: 'last', type: 'transform', expr: '"y".repeat(50000)' },
        ],
      })
      .expect(201);
    const run = await request(app.getHttpServer()).post(`/workflows/${workflow.body.id}/run`).set('x-api-key', tenant.apiKey).send({}).expect(201);
    executionId = run.body.id;
    await eventually(async () => {
      const execution = await ctx.ds.getRepository(Execution).findOneByOrFail({ id: executionId });
      expect(execution.status).toBe('succeeded');
    });
  });

  afterAll(async () => {
    await workers?.stop();
    await app?.close();
  });

  it('leaves large outputs out of the execution detail and marks them', async () => {
    const detail = await request(app.getHttpServer()).get(`/executions/${executionId}`).set('x-api-key', tenant.apiKey).expect(200);

    expect(detail.body).toMatchObject({ status: 'succeeded', output: null, outputTruncated: true });
    expect(detail.body.steps.map((s: Record<string, unknown>) => [s.stepId, s.output, s.outputTruncated])).toEqual([
      ['big', null, true],
      ['small', { size: 100_000 }, false],
      ['last', null, true],
    ]);
    expect(JSON.stringify(detail.body).length).toBeLessThan(10_000);
  });

  it('sends the same compact snapshot on the event stream', async () => {
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const events = await openEventStream(`http://127.0.0.1:${port}/executions/${executionId}/events`, { 'x-api-key': tenant.apiKey });
    await events.ended;

    const snapshot = JSON.parse(events.events.find((e) => e.event === 'snapshot')?.data ?? '{}');
    expect(snapshot.outputTruncated).toBe(true);
    expect(snapshot.steps[0]).toMatchObject({ stepId: 'big', output: null, outputTruncated: true });
    expect(events.body.length).toBeLessThan(10_000);
  });

  it('returns a full step output and the full execution output on request', async () => {
    const step = await request(app.getHttpServer()).get(`/executions/${executionId}/steps/0/output`).set('x-api-key', tenant.apiKey).expect(200);
    const output = await request(app.getHttpServer()).get(`/executions/${executionId}/output`).set('x-api-key', tenant.apiKey).expect(200);

    expect(step.headers['content-type']).toMatch(/^application\/json/);
    expect(step.body).toBe('x'.repeat(100_000));
    expect(output.body).toBe('y'.repeat(50_000));
  });

  it('does not return outputs of another tenant or of steps that did not run', async () => {
    await request(app.getHttpServer()).get(`/executions/${executionId}/steps/0/output`).set('x-api-key', other.apiKey).expect(404);
    await request(app.getHttpServer()).get(`/executions/${executionId}/output`).set('x-api-key', other.apiKey).expect(404);
    await request(app.getHttpServer()).get(`/executions/${executionId}/steps/7/output`).set('x-api-key', tenant.apiKey).expect(404);
    await request(app.getHttpServer()).get(`/executions/${executionId}/steps/-1/output`).set('x-api-key', tenant.apiKey).expect(400);
  });
});

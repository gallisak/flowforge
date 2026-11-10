import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Job } from '../../../src/entities';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant } from '../../support/db';
import { eventually } from '../../support/eventually';
import { Receiver, startReceiver } from '../../support/receiver';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

describe('F-19 an execution keeps the workflow version it started with', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let receiver: Receiver;
  let workers: InProcessWorkers | undefined;
  let tenant: SeededTenant;
  let flakyCalls = 0;
  const saved = { base: process.env.RETRY_BASE_MS, cap: process.env.RETRY_CAP_MS };

  const hits = (path: string) => receiver.requests.filter((r) => r.path === path).length;

  beforeAll(async () => {
    process.env.RETRY_BASE_MS = '2000';
    process.env.RETRY_CAP_MS = '2000';
    app = await createTestApp();
    tenant = await seedTenant(ctx.ds, 'edits-workflows');
    receiver = await startReceiver((req, res) => {
      const status = req.path === '/v1-flaky' && flakyCalls++ === 0 ? 500 : 200;
      res.writeHead(status, { 'content-type': 'application/json' }).end('{}');
    });
  });

  afterAll(async () => {
    await workers?.stop();
    await app?.close();
    await receiver?.close();
    for (const [name, value] of [
      ['RETRY_BASE_MS', saved.base],
      ['RETRY_CAP_MS', saved.cap],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('retries with the steps of the version it started with after the workflow was edited', async () => {
    const server = app.getHttpServer();
    const created = await request(server)
      .post('/workflows')
      .set('x-api-key', tenant.apiKey)
      .send({
        name: 'versioned',
        steps: [
          { id: 'first', type: 'http', url: `${receiver.url}/v1-first` },
          { id: 'second', type: 'http', url: `${receiver.url}/v1-flaky` },
        ],
      })
      .expect(201);
    const run = await request(server).post(`/workflows/${created.body.id}/run`).set('x-api-key', tenant.apiKey).send({}).expect(201);

    workers = await startInProcessWorkers(1);
    await eventually(async () =>
      expect(await ctx.ds.getRepository(Job).findOneByOrFail({ executionId: run.body.id })).toMatchObject({
        status: 'queued',
        attempts: 1,
      }),
    );

    await request(server)
      .patch(`/workflows/${created.body.id}`)
      .set('x-api-key', tenant.apiKey)
      .send({
        steps: [
          { id: 'first', type: 'http', url: `${receiver.url}/v2-first` },
          { id: 'second', type: 'http', url: `${receiver.url}/v2-only` },
        ],
      })
      .expect(200);

    await eventually(
      async () => expect(await ctx.ds.getRepository(Job).findOneByOrFail({ executionId: run.body.id })).toMatchObject({ status: 'done' }),
      { timeoutMs: 20_000 },
    );

    expect(hits('/v1-flaky')).toBe(2);
    expect(hits('/v2-first')).toBe(0);
    expect(hits('/v2-only')).toBe(0);
    const execution = await request(server).get(`/executions/${run.body.id}`).set('x-api-key', tenant.apiKey).expect(200);
    expect(execution.body).toMatchObject({ status: 'succeeded', workflowVersion: 1 });
  });
});

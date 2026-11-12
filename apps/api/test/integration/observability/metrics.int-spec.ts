import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { Execution, Job } from '../../../src/entities';
import { registerDatabaseGauges, registry } from '../../../src/observability/metrics';
import { OpsServer, startOpsServer } from '../../../src/observability/ops-server';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { Receiver, startReceiver } from '../../support/receiver';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

type Labels = Record<string, string>;

async function sampleValue(name: string, labels: Labels = {}, sampleName = name): Promise<number> {
  const metric = registry.getSingleMetric(name);
  if (!metric) return 0;
  const { values } = await metric.get();
  return values
    .filter((v) => (v as { metricName?: string }).metricName === undefined || (v as { metricName?: string }).metricName === sampleName)
    .filter((v) => Object.entries(labels).every(([key, value]) => String(v.labels[key]) === value))
    .reduce((sum, v) => sum + v.value, 0);
}

const histogramCount = (name: string, labels: Labels = {}) => sampleValue(name, labels, `${name}_count`);

describe('metrics and health endpoints', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let ops: OpsServer;
  let receiver: Receiver;
  let workers: InProcessWorkers;
  let tenant: SeededTenant;
  let ready = true;
  const saved = { base: process.env.RETRY_BASE_MS, cap: process.env.RETRY_CAP_MS };

  const opsGet = (path: string) => request(`http://127.0.0.1:${ops.port}`).get(path);

  async function finish(steps: Parameters<typeof seedWorkflow>[2], maxAttempts = 3): Promise<Execution> {
    const workflow = await seedWorkflow(ctx.ds, tenant.tenant.id, steps);
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.tenant.id, workflowId: workflow.id, input: {} });
    await ctx.ds.getRepository(Job).save({ tenantId: tenant.tenant.id, executionId: execution.id, maxAttempts });
    return eventually(async () => {
      const current = await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id });
      expect(['succeeded', 'failed']).toContain(current.status);
      return current;
    });
  }

  beforeAll(async () => {
    process.env.RETRY_BASE_MS = '50';
    process.env.RETRY_CAP_MS = '100';
    app = await createTestApp();
    registerDatabaseGauges(app.get(DataSource), 2);
    ops = await startOpsServer(0, async () => ready);
    receiver = await startReceiver((_req, res) => {
      res.writeHead(500).end();
    });
    tenant = await seedTenant(ctx.ds, 'measured');
    workers = await startInProcessWorkers(1);
  });

  afterAll(async () => {
    await workers?.stop();
    await ops?.close();
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

  it('exposes every required metric in the Prometheus format', async () => {
    const response = await opsGet('/metrics').expect(200);

    expect(response.headers['content-type']).toContain('text/plain');
    for (const name of [
      'flowforge_queue_depth',
      'flowforge_job_claim_latency_seconds',
      'flowforge_step_duration_seconds',
      'flowforge_job_retries_total',
      'flowforge_jobs_dead_total',
      'flowforge_outbox_backlog',
      'flowforge_http_request_duration_seconds',
    ]) {
      expect(response.text).toContain(`# TYPE ${name} `);
    }
  });

  it('counts claims, step durations and finished jobs when a workflow runs', async () => {
    const before = {
      claims: await histogramCount('flowforge_job_claim_latency_seconds'),
      steps: await histogramCount('flowforge_step_duration_seconds', { type: 'log', outcome: 'succeeded' }),
      finished: await sampleValue('flowforge_jobs_finished_total', { outcome: 'succeeded' }),
    };

    await finish([{ id: 'note', type: 'log', message: 'measure me' }]);

    expect(await histogramCount('flowforge_job_claim_latency_seconds')).toBe(before.claims + 1);
    expect(await histogramCount('flowforge_step_duration_seconds', { type: 'log', outcome: 'succeeded' })).toBe(before.steps + 1);
    expect(await sampleValue('flowforge_jobs_finished_total', { outcome: 'succeeded' })).toBe(before.finished + 1);
  });

  it('counts retries and jobs that used up their attempts', async () => {
    const before = {
      retries: await sampleValue('flowforge_job_retries_total', { reason: 'step_error' }),
      dead: await sampleValue('flowforge_jobs_dead_total', { reason: 'attempts_exhausted' }),
      failedSteps: await histogramCount('flowforge_step_duration_seconds', { type: 'http', outcome: 'failed' }),
    };

    await finish([{ id: 'call', type: 'http', url: `${receiver.url}/flaky` }], 3);

    expect(await sampleValue('flowforge_job_retries_total', { reason: 'step_error' })).toBe(before.retries + 2);
    expect(await sampleValue('flowforge_jobs_dead_total', { reason: 'attempts_exhausted' })).toBe(before.dead + 1);
    expect(await histogramCount('flowforge_step_duration_seconds', { type: 'http', outcome: 'failed' })).toBe(before.failedSteps + 3);
  });

  it('reports the queue depth of the largest tenants and sums the rest, counting jobs that wait for a timer as delayed', async () => {
    for (const [name, count] of [
      ['busy', 5],
      ['steady', 3],
      ['small-a', 1],
      ['small-b', 1],
    ] as const) {
      const owner = await seedTenant(ctx.ds, name);
      const workflow = await seedWorkflow(ctx.ds, owner.tenant.id, [{ id: 'note', type: 'log', message: 'x' }]);
      for (let i = 0; i < count; i++) {
        const execution = await ctx.ds.getRepository(Execution).save({ tenantId: owner.tenant.id, workflowId: workflow.id, input: {} });
        await ctx.ds.getRepository(Job).save({ tenantId: owner.tenant.id, executionId: execution.id, runAt: new Date(Date.now() + 3_600_000) });
      }
    }

    const text = (await opsGet('/metrics').expect(200)).text;
    const queued = text.split('\n').filter((line) => line.startsWith('flowforge_queue_depth{') && line.includes('status="delayed"'));

    expect(queued).toHaveLength(3);
    expect(queued.map((line) => Number(line.split(' ').pop())).sort((a, b) => b - a)).toEqual([5, 3, 2]);
    expect(queued.some((line) => line.includes('tenant_id="other"'))).toBe(true);
  });

  it('records the route template of API requests', async () => {
    await request(app.getHttpServer()).get('/executions/00000000-0000-0000-0000-000000000000').set('x-api-key', tenant.apiKey).expect(404);

    expect(await histogramCount('flowforge_http_request_duration_seconds', { route: '/executions/:id', status_code: '404' })).toBeGreaterThan(0);
  });

  it('answers liveness and readiness, and stops being ready while shutting down', async () => {
    await opsGet('/health/live').expect(200);
    await opsGet('/health/ready').expect(200);

    ready = false;
    await opsGet('/health/ready').expect(503);
    ready = true;

    ops.markShuttingDown();
    await opsGet('/health/ready').expect(503);
    await opsGet('/health/live').expect(200);
  });
});

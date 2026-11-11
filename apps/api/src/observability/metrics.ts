import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import { DataSource } from 'typeorm';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300];

export const metrics = {
  httpRequestDuration: new Histogram({
    name: 'flowforge_http_request_duration_seconds',
    help: 'Duration of API requests',
    labelNames: ['method', 'route', 'status_code'],
    buckets: LATENCY_BUCKETS,
    registers: [registry],
  }),
  jobClaimLatency: new Histogram({
    name: 'flowforge_job_claim_latency_seconds',
    help: 'Time between a job becoming runnable and a worker claiming it',
    buckets: LATENCY_BUCKETS,
    registers: [registry],
  }),
  stepDuration: new Histogram({
    name: 'flowforge_step_duration_seconds',
    help: 'Duration of workflow steps',
    labelNames: ['type', 'outcome'],
    buckets: LATENCY_BUCKETS,
    registers: [registry],
  }),
  jobRetries: new Counter({
    name: 'flowforge_job_retries_total',
    help: 'Jobs scheduled for another attempt',
    labelNames: ['reason'],
    registers: [registry],
  }),
  jobsDead: new Counter({
    name: 'flowforge_jobs_dead_total',
    help: 'Jobs that used up all of their attempts',
    labelNames: ['reason'],
    registers: [registry],
  }),
  jobsFinished: new Counter({
    name: 'flowforge_jobs_finished_total',
    help: 'Jobs that reached a final state',
    labelNames: ['outcome'],
    registers: [registry],
  }),
  outboxDeliveries: new Counter({
    name: 'flowforge_outbox_deliveries_total',
    help: 'Delivery attempts of execution notifications',
    labelNames: ['outcome'],
    registers: [registry],
  }),
  scheduledRuns: new Counter({
    name: 'flowforge_scheduled_runs_total',
    help: 'Scheduled runs started or postponed by the scheduler',
    labelNames: ['outcome'],
    registers: [registry],
  }),
  rateLimitedRequests: new Counter({
    name: 'flowforge_rate_limited_requests_total',
    help: 'API requests rejected by the per tenant rate limit',
    registers: [registry],
  }),
};

const QUEUE_DEPTH = 'flowforge_queue_depth';
const OUTBOX_BACKLOG = 'flowforge_outbox_backlog';

export function registerDatabaseGauges(dataSource: DataSource, topTenants: number): void {
  for (const name of [QUEUE_DEPTH, OUTBOX_BACKLOG]) registry.removeSingleMetric(name);
  new Gauge({
    name: QUEUE_DEPTH,
    help: `Jobs waiting or running per tenant; tenants beyond the ${topTenants} largest are summed as "other"`,
    labelNames: ['tenant_id', 'status'],
    registers: [registry],
    async collect() {
      const rows: Array<{ tenant: string; status: string; jobs: number }> = await dataSource.query(
        'SELECT * FROM queue_depth_by_tenant($1)',
        [topTenants],
      );
      this.reset();
      for (const row of rows) this.set({ tenant_id: row.tenant, status: row.status }, row.jobs);
    },
  });
  new Gauge({
    name: OUTBOX_BACKLOG,
    help: 'Execution notifications waiting for delivery',
    registers: [registry],
    async collect() {
      const [row]: Array<{ events: number }> = await dataSource.query('SELECT outbox_backlog() AS events');
      this.set(row.events);
    },
  });
}

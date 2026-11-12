import { writeFileSync } from 'fs';
import { Notification } from 'pg';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../../../src/db/data-source';
import { TenantDb } from '../../../src/db/tenant-db.service';
import { StepRun, WorkflowVersion } from '../../../src/entities';
import { ApiConfig } from '../../../src/config/config';
import { ExecutionsService } from '../../../src/executions/executions.service';
import { NotificationsService } from '../../../src/notifications/notifications.service';
import { WebhookSecretsService } from '../../../src/webhooks/webhook-secrets.service';
import { WorkflowsService } from '../../../src/workflows/workflows.service';
import { useIntegrationContext } from '../../support/context';

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Total Time'?: number;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  Plans?: PlanNode[];
}

interface CapturedPlan {
  query: string;
  plan: PlanNode;
}

const TENANTS = 50;
const WORKFLOWS = 5_000;
const EXECUTIONS = 100_000;
const QUEUED_JOBS = 20_000;
const RUNNING_JOBS = 200;
const EXPIRED_LEASES = 100;
const SCHEDULED_WORKFLOWS = 1_000;
const DUE_SCHEDULES = 20;
const OUTBOX_EVENTS = 50_000;
const SLEEPING_JOBS = 10_000;
const PAGE_SIZE = 50;
const LARGE_TABLES = ['jobs', 'executions', 'step_runs', 'outbox_events', 'workflows', 'workflow_versions'];

const idOf = (prefix: string, n: number) => `${prefix}000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const sqlId = (prefix: string, expr: string) => `('${prefix}000000-0000-4000-8000-' || lpad(to_hex(${expr}), 12, '0'))::uuid`;

const TENANT_1 = idOf('00', 1);
const WORKFLOW_1 = idOf('10', 1);
const EXECUTION_OF_TENANT_1 = idOf('20', 30_001);
const SLEEPING_TENANT = idOf('00', TENANTS + 1);

function nodesOf(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodesOf)];
}

function indexesOf(plans: CapturedPlan[]): string[] {
  return [...new Set(plans.flatMap((p) => nodesOf(p.plan)).flatMap((n) => (n['Index Name'] ? [n['Index Name']] : [])))];
}

function seqScansOfLargeTables(plans: CapturedPlan[]): string[] {
  return plans
    .flatMap((p) => nodesOf(p.plan))
    .filter((n) => n['Node Type'] === 'Seq Scan' && LARGE_TABLES.includes(n['Relation Name'] ?? ''))
    .map((n) => n['Relation Name'] as string);
}

function rowsRemovedByFilter(plans: CapturedPlan[]): number {
  return plans
    .flatMap((p) => nodesOf(p.plan))
    .reduce((sum, n) => sum + (n['Rows Removed by Filter'] ?? 0) * (n['Actual Loops'] ?? 1), 0);
}

function largestSortInput(plans: CapturedPlan[]): number {
  const sorts = plans.flatMap((p) => nodesOf(p.plan)).filter((n) => n['Node Type'] === 'Sort' || n['Node Type'] === 'Incremental Sort');
  return Math.max(0, ...sorts.flatMap((n) => (n.Plans ?? []).map((child) => child['Actual Rows'] ?? Number.POSITIVE_INFINITY)));
}

describe('query plans of the hot paths on a realistically sized database', () => {
  const ctx = useIntegrationContext();
  let app: DataSource;
  let db: TenantDb;
  let executions: ExecutionsService;
  let recording: CapturedPlan[] | null = null;
  const report = new Map<string, { operation: string; statement: string; indexes: Set<string>; runs: number; maxMs: number }>();

  async function plansOf(name: string, work: () => Promise<unknown>): Promise<CapturedPlan[]> {
    recording = [];
    await work();
    const plans = recording;
    recording = null;
    for (const p of plans) {
      const statement = p.query.replace(/\s+/g, ' ').trim().slice(0, 100);
      if (statement.startsWith('SELECT set_config')) continue;
      const row = report.get(`${name}|${statement}`) ?? { operation: name, statement, indexes: new Set<string>(), runs: 0, maxMs: 0 };
      indexesOf([p]).forEach((index) => row.indexes.add(index));
      row.runs += 1;
      row.maxMs = Math.max(row.maxMs, p.plan['Actual Total Time'] ?? 0);
      report.set(`${name}|${statement}`, row);
    }
    return plans;
  }

  function expectIndexed(plans: CapturedPlan[], ...indexes: string[]): void {
    expect(plans.length).toBeGreaterThan(0);
    expect(seqScansOfLargeTables(plans)).toEqual([]);
    expect(indexesOf(plans)).toEqual(expect.arrayContaining(indexes));
  }

  async function seed(): Promise<void> {
    await ctx.ds.transaction(async (em) => {
      await em.query(`SET LOCAL session_replication_role = replica`);
      await em.query(`
        INSERT INTO "tenants" ("id", "name", "apiKeyHash")
        SELECT ${sqlId('00', 't')}, 'tenant ' || t, md5('key ' || t) FROM generate_series(1, ${TENANTS}) t`);
      await em.query(`
        INSERT INTO "workflows" ("id", "tenantId", "name", "steps", "cron", "nextRunAt")
        SELECT ${sqlId('10', 'w')}, ${sqlId('00', `((w - 1) % ${TENANTS}) + 1`)}, 'workflow ' || w,
               '[{"id":"note","type":"log","message":"hi"}]'::jsonb,
               CASE WHEN w <= ${SCHEDULED_WORKFLOWS} THEN '* * * * *' END,
               CASE WHEN w <= ${DUE_SCHEDULES} THEN now() - interval '1 minute'
                    WHEN w <= ${SCHEDULED_WORKFLOWS} THEN now() + w * interval '1 minute' END
          FROM generate_series(1, ${WORKFLOWS}) w`);
      await em.query(`
        INSERT INTO "workflow_versions" ("tenantId", "workflowId", "version", "steps")
        SELECT w."tenantId", w."id", 1, w."steps" FROM "workflows" w`);
      await em.query(`
        INSERT INTO "executions" ("id", "tenantId", "workflowId", "status", "input", "triggerKey", "createdAt", "finishedAt")
        SELECT ${sqlId('20', 'e')}, ${sqlId('00', `((e - 1) % ${TENANTS}) + 1`)}, ${sqlId('10', `(((e - 1) / ${TENANTS}) % 20) * ${TENANTS} + ((e - 1) % ${TENANTS}) + 1`)},
               CASE WHEN e <= ${QUEUED_JOBS} THEN 'pending' WHEN (e / ${TENANTS}) % 10 = 0 THEN 'failed' ELSE 'succeeded' END,
               '{}'::jsonb,
               CASE WHEN e % 5 = 0 THEN 'webhook:' || e END,
               now() - e * interval '1 second',
               CASE WHEN e > ${QUEUED_JOBS} AND e % 3 = 0 THEN now() - interval '40 days' - e * interval '1 second' END
          FROM generate_series(1, ${EXECUTIONS}) e`);
      await em.query(`
        INSERT INTO "jobs" ("tenantId", "executionId", "status", "runAt", "lockedBy", "lockedUntil", "attempts")
        SELECT e."tenantId", e."id",
               CASE WHEN n <= ${QUEUED_JOBS} THEN 'queued' WHEN n <= ${QUEUED_JOBS + RUNNING_JOBS} THEN 'running' ELSE 'done' END,
               now() - (n % 600) * interval '1 second',
               CASE WHEN n > ${QUEUED_JOBS} AND n <= ${QUEUED_JOBS + RUNNING_JOBS} THEN 'worker-seed' END,
               CASE WHEN n > ${QUEUED_JOBS} AND n <= ${QUEUED_JOBS + EXPIRED_LEASES} THEN now() - interval '1 minute'
                    WHEN n > ${QUEUED_JOBS} AND n <= ${QUEUED_JOBS + RUNNING_JOBS} THEN now() + interval '1 hour' END,
               CASE WHEN n > ${QUEUED_JOBS} THEN 1 ELSE 0 END
          FROM (SELECT x.*, row_number() OVER (ORDER BY x."createdAt" DESC) AS n FROM "executions" x) e`);
      await em.query(`
        INSERT INTO "step_runs" ("tenantId", "executionId", "stepIndex", "stepId", "status", "attempts", "output")
        SELECT e."tenantId", e."id", s, 'step_' || s, 'succeeded', 1, '{"ok":true}'::jsonb
          FROM "executions" e CROSS JOIN generate_series(0, 1) s
         WHERE e."status" <> 'pending'`);
      await em.query(`
        INSERT INTO "outbox_events" ("tenantId", "executionId", "type", "payload", "status", "nextAttemptAt", "lockedBy", "lockedUntil")
        SELECT e."tenantId", e."id", 'execution.succeeded', '{}'::jsonb,
               CASE WHEN n <= 2000 THEN 'pending' WHEN n <= 2200 THEN 'delivering' ELSE 'delivered' END,
               now() - interval '1 second',
               CASE WHEN n > 2000 AND n <= 2200 THEN 'dispatcher-seed' END,
               CASE WHEN n > 2000 AND n <= 2200 THEN now() - interval '1 minute' END
          FROM (SELECT x.*, row_number() OVER (ORDER BY x."id") AS n FROM "executions" x WHERE x."status" <> 'pending' LIMIT ${OUTBOX_EVENTS}) e`);
      await em.query(`INSERT INTO "tenants" ("id", "name", "apiKeyHash") VALUES ('${SLEEPING_TENANT}', 'sleeping', md5('sleeping'))`);
      await em.query(`
        INSERT INTO "executions" ("id", "tenantId", "workflowId", "status", "input")
        SELECT ${sqlId('30', 'e')}, '${SLEEPING_TENANT}', '${WORKFLOW_1}', 'waiting', '{}'::jsonb FROM generate_series(1, ${SLEEPING_JOBS}) e`);
      await em.query(`
        INSERT INTO "jobs" ("tenantId", "executionId", "status", "runAt")
        SELECT '${SLEEPING_TENANT}', ${sqlId('30', 'e')}, 'queued', now() + interval '1 hour' + e * interval '1 second'
          FROM generate_series(1, ${SLEEPING_JOBS}) e`);
      await em.query(`
        INSERT INTO "outbox_events" ("tenantId", "executionId", "type", "payload", "status", "nextAttemptAt")
        SELECT '${SLEEPING_TENANT}', ${sqlId('30', 'e')}, 'execution.failed', '{}'::jsonb, 'pending', now() + interval '1 hour'
          FROM generate_series(1, ${SLEEPING_JOBS}) e`);
      await em.query(`INSERT INTO "tenant_queue_state" ("tenantId") SELECT DISTINCT "tenantId" FROM "jobs" WHERE "status" = 'queued' ON CONFLICT DO NOTHING`);
    });
    for (const table of ['tenants', ...LARGE_TABLES]) await ctx.ds.query(`VACUUM ANALYZE "${table}"`);
  }

  beforeAll(async () => {
    await seed();
    for (const setting of [
      `session_preload_libraries = 'auto_explain'`,
      `auto_explain.log_min_duration = 0`,
      `auto_explain.log_nested_statements = on`,
      `auto_explain.log_analyze = on`,
      `auto_explain.log_format = 'json'`,
      `auto_explain.log_level = 'notice'`,
    ]) {
      await ctx.ds.query(`ALTER ROLE flowforge_app IN DATABASE ${ctx.db.name} SET ${setting}`);
    }
    app = await new DataSource({ ...dataSourceOptions(ctx.db.url), extra: { max: 1 } }).initialize();
    const runner = app.createQueryRunner();
    const connection = (await runner.connect()) as { on(event: 'notice', listener: (notice: Notification & { message?: string }) => void): void };
    connection.on('notice', (notice) => {
      const message = notice.message ?? '';
      const start = message.indexOf('plan:\n');
      if (!recording || start === -1) return;
      const explained = JSON.parse(message.slice(start + 'plan:\n'.length)) as { 'Query Text': string; Plan: PlanNode };
      recording.push({ query: explained['Query Text'], plan: explained.Plan });
    });
    await runner.release();
    db = new TenantDb(app);
    executions = new ExecutionsService(db, { tenantMaxQueuedJobs: 10_000, jobMaxAttempts: 8 });
  }, 120_000);

  afterAll(async () => {
    await app?.destroy();
    const target = process.env.QUERY_PLAN_REPORT;
    if (!target) return;
    const rows = [...report.values()].map(
      (r) => `| ${r.operation} | \`${r.statement.replace(/\|/g, '\\|')}\` | ${[...r.indexes].join(', ') || '-'} | ${r.runs} | ${r.maxMs.toFixed(3)} |`,
    );
    writeFileSync(target, ['| Operation | Statement | Indexes | Runs | Max time, ms |', '|---|---|---|---|---|', ...rows].join('\n') + '\n');
  });

  it('captures the plans of statements inside the database functions', async () => {
    const plans = await plansOf('claim a job', () => db.claimJob('worker-plans', 30, 10));

    expect(plans.some((p) => p.query.includes('FROM "tenant_queue_state" s'))).toBe(true);
  });

  it('claims a job from the tenants that may have ready jobs and the oldest ready job of one tenant', async () => {
    const plans = await plansOf('claim a job', () => db.claimJob('worker-plans', 30, 10));

    expectIndexed(plans, 'IDX_jobs_queued_by_tenant');
    expect(indexesOf(plans).some((index) => index === 'IDX_jobs_running_by_tenant' || index === 'IDX_jobs_expired_leases')).toBe(true);
  });

  it('claims a job without reading the jobs that are not due yet', async () => {
    const plans = await plansOf('claim a job', () => db.claimJob('worker-plans', 30, 10));

    expect(rowsRemovedByFilter(plans)).toBeLessThan(1_000);
  });

  it('finds expired leases without scanning the jobs table', async () => {
    expectIndexed(await plansOf('reap expired leases', () => db.reapExpiredJobs()), 'IDX_jobs_expired_leases');
  });

  it('checks the trigger key and the queue limit of a tenant on enqueue', async () => {
    const plans = await plansOf('enqueue with a trigger key', () =>
      executions.enqueue({ id: WORKFLOW_1, tenantId: TENANT_1 }, {}, 'webhook', 'webhook:plans:evt-1'),
    );

    expectIndexed(plans, 'UQ_executions_tenant_trigger_key', 'IDX_jobs_queued_by_tenant');
  });

  it.each([
    ['all executions', {}, 'IDX_executions_tenant_created'],
    ['executions by status', { status: 'failed' as const }, 'IDX_executions_tenant_status_created'],
    ['executions of a workflow', { workflowId: WORKFLOW_1 }, 'IDX_executions_tenant_workflow_created'],
  ])('lists %s of a tenant from an index without sorting more than a page, for the first page and the next one', async (name, filter, index) => {
    const first = await executions.list(TENANT_1, { ...filter, limit: PAGE_SIZE });
    expect(first.nextCursor).not.toBeNull();

    const plans = await plansOf(`list ${name}`, async () => {
      await executions.list(TENANT_1, { ...filter, limit: PAGE_SIZE });
      await executions.list(TENANT_1, { ...filter, limit: PAGE_SIZE, cursor: first.nextCursor ?? undefined });
    });

    expectIndexed(plans, index);
    expect(largestSortInput(plans)).toBeLessThanOrEqual(PAGE_SIZE + 1);
  });

  it('loads an execution with its steps and the checkpoints and snapshot a worker resumes from', async () => {
    const plans = await plansOf('load an execution', async () => {
      await executions.get(TENANT_1, EXECUTION_OF_TENANT_1);
      await db.run(TENANT_1, (em) => em.find(StepRun, { where: { executionId: EXECUTION_OF_TENANT_1 } }));
      await db.run(TENANT_1, (em) => em.findOne(WorkflowVersion, { where: { workflowId: WORKFLOW_1, version: 1 } }));
    });

    expectIndexed(plans, 'UQ_step_runs_execution_step', 'UQ_workflow_versions_workflow_version');
  });

  it('claims the next due schedule from the index of next runs', async () => {
    const plans = await plansOf('claim a due schedule', () => db.claimDueSchedule(new Date(), async () => undefined));

    expectIndexed(plans, 'IDX_workflows_due');
  });

  it('claims due and abandoned notifications from their partial indexes', async () => {
    const plans = await plansOf('claim outbox events', () => db.claimOutboxEvents('dispatcher-plans', 30, 10, 2));

    expectIndexed(plans, 'IDX_outbox_events_pending_by_tenant', 'IDX_outbox_events_expired_leases');
    expect(rowsRemovedByFilter(plans)).toBeLessThan(1_000);
  });

  it('lists the workflows of a tenant page by page from an index', async () => {
    const workflows = new WorkflowsService(db, { tenantMaxWorkflows: 10_000 });
    const first = await workflows.list(TENANT_1, { limit: 20 });
    expect(first.nextCursor).not.toBeNull();

    const plans = await plansOf('list workflows', async () => {
      await workflows.list(TENANT_1, { limit: 20 });
      await workflows.list(TENANT_1, { limit: 20, cursor: first.nextCursor ?? undefined });
    });

    expectIndexed(plans, 'IDX_workflows_tenant_created');
    expect(largestSortInput(plans)).toBeLessThanOrEqual(21);
  });

  it('measures the queue depth per tenant from the partial indexes only', async () => {
    const plans = await plansOf('queue depth metric', () => app.query('SELECT * FROM queue_depth_by_tenant(20)'));

    expectIndexed(plans, 'IDX_jobs_queued_by_tenant');
    expect(indexesOf(plans).some((index) => index === 'IDX_jobs_running_by_tenant' || index === 'IDX_jobs_expired_leases')).toBe(true);
  });

  it.each([
    ['a large tenant', TENANT_1],
    ['a tenant without delivered notifications', SLEEPING_TENANT],
  ])('lists the delivered notifications of %s from its own index without reading other tenants', async (_case, tenant) => {
    const notifications = new NotificationsService(db, {} as WebhookSecretsService, { ssrfAllowlist: [] } as unknown as ApiConfig);
    const plans = await plansOf('list notifications by status', () => notifications.events(tenant, { status: 'delivered', limit: 20 }));

    expectIndexed(plans, 'IDX_outbox_events_tenant_status_created');
    expect(rowsRemovedByFilter(plans)).toBeLessThan(100);
    expect(largestSortInput(plans)).toBe(0);
  });

  it.each([
    ['a large tenant', TENANT_1],
    ['a tenant without delivered notifications', SLEEPING_TENANT],
  ])('lists all notifications of %s from its own index without reading other tenants', async (_case, tenant) => {
    const notifications = new NotificationsService(db, {} as WebhookSecretsService, { ssrfAllowlist: [] } as unknown as ApiConfig);
    const plans = await plansOf('list notifications', () => notifications.events(tenant, { limit: 20 }));

    expectIndexed(plans, 'IDX_outbox_events_tenant_created');
    expect(rowsRemovedByFilter(plans)).toBeLessThan(100);
    expect(largestSortInput(plans)).toBe(0);
  });

  it('finds finished executions and notifications to purge from their partial indexes', async () => {
    const plans = await plansOf('purge finished data', () => db.purgeFinishedData(30, 1_000));

    expect(await ctx.ds.query(`SELECT 1 FROM "executions" WHERE "finishedAt" < now() - interval '30 days' LIMIT 1`)).toHaveLength(1);
    expect(seqScansOfLargeTables(plans)).not.toContain('outbox_events');
    expect(indexesOf(plans)).toEqual(expect.arrayContaining(['IDX_executions_finished', 'IDX_outbox_events_finished']));
    expect(seqScansOfLargeTables(plans).filter((table) => !['workflows', 'workflow_versions'].includes(table))).toEqual([]);
  });
});

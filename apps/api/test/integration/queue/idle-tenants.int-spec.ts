import { Client } from 'pg';
import { Execution, Job } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';

const IDLE_TENANTS = 200;

describe('claiming jobs while many tenants have nothing due', () => {
  const ctx = useIntegrationContext();
  let app: Client;

  async function tenantWithJob(name: string, runAt: Date): Promise<{ tenantId: string; workflowId: string }> {
    const { tenant } = await seedTenant(ctx.ds, name);
    const workflow = await seedWorkflow(ctx.ds, tenant.id, [{ id: 'note', type: 'log', message: 'x' }]);
    await enqueue(tenant.id, workflow.id, runAt);
    return { tenantId: tenant.id, workflowId: workflow.id };
  }

  async function enqueue(tenantId: string, workflowId: string, runAt: Date, client?: Client): Promise<void> {
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId, workflowId, input: {} });
    if (client) {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      await client.query(`INSERT INTO jobs ("tenantId", "executionId", "runAt") VALUES ($1, $2, $3)`, [tenantId, execution.id, runAt]);
      await client.query('COMMIT');
    } else {
      await ctx.ds.getRepository(Job).save({ tenantId, executionId: execution.id, runAt });
    }
  }

  const claim = async (client = app): Promise<string | undefined> =>
    (await client.query<{ tenantId: string }>(`SELECT * FROM claim_job('idle-test', 30)`)).rows[0]?.tenantId;

  async function scansOfJobs(): Promise<number> {
    const { rows } = await app.query<{ scans: string }>(
      `SELECT coalesce(idx_scan, 0) + coalesce(seq_scan, 0) AS scans FROM pg_stat_xact_user_tables WHERE relname = 'jobs'`,
    );
    return Number(rows[0]?.scans ?? 0);
  }

  async function jobScansOfOneClaim(): Promise<number> {
    await app.query('BEGIN');
    try {
      const before = await scansOfJobs();
      await claim();
      return (await scansOfJobs()) - before;
    } finally {
      await app.query('ROLLBACK');
    }
  }

  beforeAll(async () => {
    app = new Client({ connectionString: ctx.db.url });
    await app.connect();
    ctx.onTeardown(() => app.end());
  });

  beforeEach(async () => {
    await ctx.ds.query(`DELETE FROM jobs`);
  });

  it('does not look at the jobs of tenants that have nothing due on every claim', async () => {
    const later = new Date(Date.now() + 3_600_000);
    for (let i = 0; i < IDLE_TENANTS; i++) await tenantWithJob(`idle-${i}`, later);
    expect(await claim()).toBeUndefined();

    expect(await jobScansOfOneClaim()).toBeLessThan(10);
  });

  it('claims a job of an idle tenant as soon as it is enqueued', async () => {
    const { tenantId, workflowId } = await tenantWithJob('wakes-on-enqueue', new Date(Date.now() + 3_600_000));
    expect(await claim()).toBeUndefined();

    await enqueue(tenantId, workflowId, new Date(Date.now() - 1_000));

    expect(await claim()).toBe(tenantId);
  });

  it('claims a waiting job once it is due without anything else happening', async () => {
    const { tenantId } = await tenantWithJob('wakes-on-time', new Date(Date.now() + 1_500));
    expect(await claim()).toBeUndefined();

    await eventually(async () => expect(await claim()).toBe(tenantId), { timeoutMs: 5_000 });
  });

  it('never marks a tenant idle while a job of that tenant is being enqueued', async () => {
    const enqueuer = new Client({ connectionString: ctx.db.url });
    await enqueuer.connect();
    try {
      const { tenantId, workflowId } = await tenantWithJob('racing', new Date(Date.now() + 3_600_000));
      const execution = await ctx.ds.getRepository(Execution).save({ tenantId, workflowId, input: {} });
      await enqueuer.query('BEGIN');
      await enqueuer.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      await enqueuer.query(`INSERT INTO jobs ("tenantId", "executionId", "runAt") VALUES ($1, $2, now() - interval '1 second')`, [tenantId, execution.id]);

      expect(await claim()).toBeUndefined();
      await enqueuer.query('COMMIT');

      expect(await claim()).toBe(tenantId);
    } finally {
      await enqueuer.end();
    }
  });

  it('lets go of a tenant it skipped while it goes on to claim for another tenant', async () => {
    const holder = new Client({ connectionString: ctx.db.adminUrl });
    await holder.connect();
    try {
      const skipped = await tenantWithJob('skipped', new Date(Date.now() - 60_000));
      const claimed = await tenantWithJob('claimed', new Date(Date.now() - 1_000));
      await ctx.ds.query(
        `INSERT INTO tenant_queue_state ("tenantId", "lastClaimedAt") VALUES ($1, NULL), ($2, now())
         ON CONFLICT ("tenantId") DO UPDATE SET "lastClaimedAt" = EXCLUDED."lastClaimedAt"`,
        [skipped.tenantId, claimed.tenantId],
      );
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM jobs WHERE "tenantId" = $1 FOR UPDATE`, [skipped.tenantId]);

      await app.query('BEGIN');
      try {
        expect(await claim()).toBe(claimed.tenantId);
        const rows = await ctx.ds.query(`SELECT 1 FROM tenant_queue_state WHERE "tenantId" = $1 FOR UPDATE NOWAIT`, [skipped.tenantId]);
        expect(rows).toHaveLength(1);
      } finally {
        await app.query('ROLLBACK');
      }
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
  });
});

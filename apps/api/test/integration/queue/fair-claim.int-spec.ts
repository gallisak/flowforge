import { Client } from 'pg';
import { Execution, Job } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow } from '../../support/db';

describe('fair job claim', () => {
  const ctx = useIntegrationContext();
  let app: Client;

  async function tenantWithJobs(name: string, count: number, runAt = new Date(Date.now() - 1_000)): Promise<string> {
    const { tenant } = await seedTenant(ctx.ds, name);
    const workflow = await seedWorkflow(ctx.ds, tenant.id, [{ id: 'note', type: 'log', message: 'x' }]);
    const executions = await ctx.ds
      .getRepository(Execution)
      .save(Array.from({ length: count }, () => ({ tenantId: tenant.id, workflowId: workflow.id, input: {} })));
    await ctx.ds.getRepository(Job).save(executions.map((e) => ({ tenantId: tenant.id, executionId: e.id, runAt })));
    return tenant.id;
  }

  const claim = async (): Promise<string | undefined> =>
    (await app.query<{ tenantId: string }>(`SELECT * FROM claim_job('fair-test', 30)`)).rows[0]?.tenantId;

  beforeAll(async () => {
    app = new Client({ connectionString: ctx.db.url });
    await app.connect();
    ctx.onTeardown(() => app.end());
  });

  beforeEach(async () => {
    await ctx.ds.query(`DELETE FROM jobs`);
    await ctx.ds.query(`DELETE FROM tenant_queue_state`);
  });

  it('takes turns between tenants regardless of how much each one queued', async () => {
    const big = await tenantWithJobs('big', 50, new Date(Date.now() - 60_000));
    const small = await tenantWithJobs('small', 2);
    const medium = await tenantWithJobs('medium', 3);

    const order = [];
    for (let i = 0; i < 9; i++) order.push(await claim());

    expect(order.slice(0, 3).sort()).toEqual([big, small, medium].sort());
    expect(order.slice(3, 6).sort()).toEqual([big, small, medium].sort());
    expect(order.slice(6, 9).sort()).toEqual([big, big, medium].sort());
  });

  it('claims the oldest ready job of the chosen tenant', async () => {
    const tenantId = await tenantWithJobs('ordered', 1, new Date(Date.now() - 10_000));
    const workflowRow = await ctx.ds.getRepository(Execution).findOneByOrFail({ tenantId });
    const newer = await ctx.ds.getRepository(Execution).save({ tenantId, workflowId: workflowRow.workflowId, input: {} });
    await ctx.ds.getRepository(Job).save({ tenantId, executionId: newer.id, runAt: new Date(Date.now() - 1_000) });

    const { rows } = await app.query<{ executionId: string }>(`SELECT * FROM claim_job('fair-test', 30)`);
    expect(rows[0].executionId).toBe(workflowRow.id);
  });

  it('ignores jobs that are not due yet', async () => {
    await tenantWithJobs('later', 3, new Date(Date.now() + 60_000));
    expect(await claim()).toBeUndefined();
  });

  it('moves on to the next tenant while another worker is claiming for the first one', async () => {
    const first = await tenantWithJobs('first', 2);
    const second = await tenantWithJobs('second', 2);
    await ctx.ds.query(
      `INSERT INTO tenant_queue_state ("tenantId", "lastClaimedAt") VALUES ($1, NULL), ($2, now())
       ON CONFLICT ("tenantId") DO UPDATE SET "lastClaimedAt" = EXCLUDED."lastClaimedAt"`,
      [first, second],
    );

    const holder = new Client({ connectionString: ctx.db.adminUrl });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM tenant_queue_state WHERE "tenantId" = $1 FOR UPDATE`, [first]);
      expect(await claim()).toBe(second);
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
    expect(await claim()).toBe(first);
  });

  it('gives every concurrent claimer a job when a single tenant has enough work', async () => {
    await tenantWithJobs('only-tenant', 20);
    const clients = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const client = new Client({ connectionString: ctx.db.url });
        await client.connect();
        return client;
      }),
    );
    try {
      const claimed = await Promise.all(clients.map((c) => c.query(`SELECT * FROM claim_job('fair-test', 30)`)));
      expect(claimed.map((r) => r.rows.length)).toEqual(Array(8).fill(1));
      expect(new Set(claimed.map((r) => r.rows[0].id)).size).toBe(8);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });

  it('keeps its scheduling state away from the application role', async () => {
    await expect(app.query('SELECT * FROM tenant_queue_state')).rejects.toThrow(/permission denied/);
  });
});

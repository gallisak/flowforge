import { Client } from 'pg';
import { hashApiKey } from '../../../src/auth/api-key.guard';
import { Execution, Job, StepRun } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow, SeededTenant } from '../../support/db';

const TENANT_TABLES = [
  { table: 'tenants', tenantColumn: 'id' },
  { table: 'workflows', tenantColumn: 'tenantId' },
  { table: 'workflow_versions', tenantColumn: 'tenantId' },
  { table: 'executions', tenantColumn: 'tenantId' },
  { table: 'step_runs', tenantColumn: 'tenantId' },
  { table: 'jobs', tenantColumn: 'tenantId' },
] as const;

describe('row level security for the application role (queries that bypass the service layer)', () => {
  const ctx = useIntegrationContext();
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  let app: Client;

  async function seedTenantData(seeded: SeededTenant): Promise<void> {
    const workflow = await seedWorkflow(ctx.ds, seeded.tenant.id, [{ id: 'hello', type: 'log', message: 'hi' }]);
    const execution = await ctx.ds
      .getRepository(Execution)
      .save({ tenantId: seeded.tenant.id, workflowId: workflow.id, input: { secret: seeded.tenant.name } });
    await ctx.ds
      .getRepository(StepRun)
      .save({ tenantId: seeded.tenant.id, executionId: execution.id, stepIndex: 0, stepId: 'hello' });
    await ctx.ds.getRepository(Job).save({ tenantId: seeded.tenant.id, executionId: execution.id });
  }

  async function asTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      return await work();
    } finally {
      await app.query('ROLLBACK');
    }
  }

  async function count(table: string): Promise<number> {
    const { rows } = await app.query(`SELECT count(*)::int AS n FROM "${table}"`);
    return rows[0].n;
  }

  beforeAll(async () => {
    tenantA = await seedTenant(ctx.ds, 'tenant-a');
    tenantB = await seedTenant(ctx.ds, 'tenant-b');
    await seedTenantData(tenantA);
    await seedTenantData(tenantB);
    app = new Client({ connectionString: ctx.db.url });
    await app.connect();
    ctx.onTeardown(() => app.end());
  });

  it.each(TENANT_TABLES)('sees no rows in $table without a tenant context', async ({ table }) => {
    expect(await count(table)).toBe(0);
  });

  it('still sees nothing after a transaction with a tenant context has ended on the same connection', async () => {
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA.tenant.id]);
    await app.query('COMMIT');

    for (const { table } of TENANT_TABLES) {
      expect(await count(table)).toBe(0);
    }
  });

  it.each(TENANT_TABLES)('sees only the rows of the current tenant in $table', async ({ table, tenantColumn }) => {
    const owners = await asTenant(tenantA.tenant.id, async () => {
      const { rows } = await app.query(`SELECT DISTINCT "${tenantColumn}" AS owner FROM "${table}"`);
      return rows.map((row: { owner: string }) => row.owner);
    });
    expect(owners).toEqual([tenantA.tenant.id]);
  });

  it('cannot update or delete rows of another tenant', async () => {
    const affected = await asTenant(tenantA.tenant.id, async () => {
      const updated = await app.query(`UPDATE workflows SET name = 'hijacked' WHERE "tenantId" = $1`, [tenantB.tenant.id]);
      const deleted = await app.query(`DELETE FROM executions WHERE "tenantId" = $1`, [tenantB.tenant.id]);
      return { updated: updated.rowCount, deleted: deleted.rowCount };
    });

    expect(affected).toEqual({ updated: 0, deleted: 0 });
    const [workflowB] = await ctx.ds.query(`SELECT name FROM workflows WHERE "tenantId" = $1`, [tenantB.tenant.id]);
    expect(workflowB.name).toBe('test-workflow');
    expect(await ctx.ds.getRepository(Execution).countBy({ tenantId: tenantB.tenant.id })).toBe(1);
  });

  it('cannot insert a row that belongs to another tenant', async () => {
    await expect(
      asTenant(tenantA.tenant.id, () =>
        app.query(`INSERT INTO workflows ("tenantId", name, steps) VALUES ($1, 'planted', '[]')`, [tenantB.tenant.id]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot move its own row to another tenant', async () => {
    await expect(
      asTenant(tenantA.tenant.id, () =>
        app.query(`UPDATE workflows SET "tenantId" = $1 WHERE "tenantId" = $2`, [tenantB.tenant.id, tenantA.tenant.id]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it.each(TENANT_TABLES)('cannot switch off row level security on $table', async ({ table }) => {
    await expect(app.query(`ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY`)).rejects.toThrow(/must be owner/);
  });

  it('authenticates by API key hash without exposing secrets', async () => {
    const { rows } = await app.query('SELECT * FROM auth_tenant($1)', [hashApiKey(tenantA.apiKey)]);
    expect(rows).toEqual([{ id: tenantA.tenant.id, name: 'tenant-a' }]);

    const wrong = await app.query('SELECT * FROM auth_tenant($1)', [hashApiKey('ff_not_a_key')]);
    expect(wrong.rows).toEqual([]);
  });

  it('hands out a single claimed job through the queue function and nothing else', async () => {
    const claimed = await app.query('SELECT * FROM claim_job($1, 30)', ['rls-probe']);
    expect(claimed.rows).toHaveLength(1);
    expect(claimed.rows[0]).toMatchObject({ status: 'running', lockedBy: 'rls-probe' });
    expect(await count('jobs')).toBe(0);
  });

  it('exposes only the tenant id through the webhook function', async () => {
    const [workflowA] = await ctx.ds.query(`SELECT id FROM workflows WHERE "tenantId" = $1`, [tenantA.tenant.id]);
    const webhook = await app.query('SELECT resolve_webhook_tenant($1) AS "tenantId"', [workflowA.id]);
    expect(webhook.rows).toEqual([{ tenantId: tenantA.tenant.id }]);
  });
});

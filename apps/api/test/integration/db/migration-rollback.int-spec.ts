import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../../../src/db/data-source';
import { useIntegrationContext } from '../../support/context';
import { seedTenant } from '../../support/db';

describe('rolling migrations back', () => {
  const ctx = useIntegrationContext();
  let owner: DataSource;

  const applied = async () => (await owner.query(`SELECT name FROM migrations ORDER BY id DESC`)).map((row: { name: string }) => row.name);

  async function undoUntil(name: string): Promise<void> {
    while ((await applied())[0] !== name) await owner.undoLastMigration({ transaction: 'each' });
  }

  beforeAll(async () => {
    owner = await new DataSource(dataSourceOptions(ctx.db.ownerUrl)).initialize();
  });

  afterAll(async () => {
    await owner?.destroy();
  });

  it('gives the application role no privilege it did not have before the least privilege migration', async () => {
    await undoUntil('TenantAwareClaims1794321500000');

    const [{ truncate }]: Array<{ truncate: boolean }> = await ctx.ds.query(
      `SELECT has_table_privilege('flowforge_app', 'tenants', 'TRUNCATE') OR has_table_privilege('flowforge_app', 'workflow_versions', 'TRUNCATE') AS truncate`,
    );
    expect(truncate).toBe(false);
  });

  it('restores the inbound secret of every tenant when the secret table is removed', async () => {
    const plain = await seedTenant(ctx.ds, 'without-secrets');
    const notified = await seedTenant(ctx.ds, 'with-outbound-secret');
    await ctx.ds.query(`INSERT INTO webhook_secrets ("tenantId", secret, purpose, "createdAt") VALUES ($1, 'whsec_inbound', 'inbound', now() - interval '1 day')`, [notified.tenant.id]);
    await ctx.ds.query(`INSERT INTO webhook_secrets ("tenantId", secret, purpose) VALUES ($1, 'whsec_outbound', 'outbound')`, [notified.tenant.id]);
    await ctx.ds.query(`DELETE FROM webhook_secrets WHERE "tenantId" = $1`, [plain.tenant.id]);

    await undoUntil('ExecutionTriggerKeys1794320000000');

    const rows: Array<{ id: string; webhookSecret: string }> = await ctx.ds.query(`SELECT id, "webhookSecret" FROM tenants WHERE id = ANY($1)`, [
      [plain.tenant.id, notified.tenant.id],
    ]);
    const secretOf = (id: string) => rows.find((row) => row.id === id)?.webhookSecret;
    expect(secretOf(notified.tenant.id)).toBe('whsec_inbound');
    expect(secretOf(plain.tenant.id)).toMatch(/^whsec_.{20,}/);
  });
});

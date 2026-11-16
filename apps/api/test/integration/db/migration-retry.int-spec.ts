import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../../../src/db/data-source';
import { runMigrations } from '../../../src/db/run-migrations';
import { EXECUTION_REFERENCES, TenantConsistentReferences1794322200000 } from '../../../src/migrations/1794322200000-tenant-consistent-references';
import { useIntegrationContext } from '../../support/context';

const MIGRATION = new TenantConsistentReferences1794322200000().name;

describe('retrying the tenant consistent references migration after it stopped half way', () => {
  const ctx = useIntegrationContext();
  let owner: DataSource;

  const constraintsInPlace = async () =>
    (
      await ctx.ds.query(
        `SELECT conname FROM pg_constraint WHERE conname = ANY($1) AND convalidated ORDER BY conname`,
        [['UQ_executions_tenant_id', ...EXECUTION_REFERENCES.map((reference) => reference.constraint)]],
      )
    ).map((row: { conname: string }) => row.conname);

  const forgetMigration = () => owner.query(`DELETE FROM migrations WHERE name = $1`, [MIGRATION]);

  const dropReferences = async (tables: readonly string[]) => {
    for (const { table, constraint } of EXECUTION_REFERENCES.filter((reference) => tables.includes(reference.table))) {
      await owner.query(`ALTER TABLE "${table}" DROP CONSTRAINT "${constraint}"`);
    }
  };

  beforeAll(async () => {
    owner = await new DataSource(dataSourceOptions(ctx.db.ownerUrl)).initialize();
  });

  afterAll(async () => {
    await owner?.destroy();
  });

  it('finishes when the unique constraint and the first reference were already added', async () => {
    await dropReferences(['jobs', 'outbox_events']);
    await forgetMigration();

    await expect(runMigrations(ctx.db.ownerUrl)).resolves.toEqual([MIGRATION]);
    expect(await constraintsInPlace()).toHaveLength(4);
  });

  it('rebuilds a unique index that an interrupted concurrent build left invalid', async () => {
    await dropReferences(EXECUTION_REFERENCES.map((reference) => reference.table));
    await owner.query(`ALTER TABLE "executions" DROP CONSTRAINT "UQ_executions_tenant_id"`);
    await owner.query(`CREATE UNIQUE INDEX "UQ_executions_tenant_id" ON "executions" ("tenantId", "id")`);
    await ctx.ds.query(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '"UQ_executions_tenant_id"'::regclass`);
    await forgetMigration();

    await expect(runMigrations(ctx.db.ownerUrl)).resolves.toEqual([MIGRATION]);
    expect(await constraintsInPlace()).toHaveLength(4);
  });
});

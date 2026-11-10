import { randomBytes } from 'crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../../../src/db/data-source';
import { runMigrations } from '../../../src/db/run-migrations';
import { migrations } from '../../../src/migrations';
import { useIntegrationContext } from '../../support/context';
import { DB_ROLES, EMPTY_TEMPLATE_DB, withCredentials, withDatabase } from '../../support/schema';

describe('database migrations', () => {
  const ctx = useIntegrationContext();

  it('produce exactly the schema described by the entities', async () => {
    const ds = await new DataSource(dataSourceOptions(ctx.db.ownerUrl)).initialize();
    try {
      const pending = await ds.driver.createSchemaBuilder().log();
      expect(pending.upQueries.map((query) => query.query)).toEqual([]);
    } finally {
      await ds.destroy();
    }
  });

  it('leave every table owned by the migration role, not by the application role', async () => {
    const rows: Array<{ tableowner: string }> = await ctx.ds.query(
      `SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public'`,
    );
    expect(rows).toEqual([{ tableowner: DB_ROLES.owner.user }]);
  });

  it('are a no-op when the schema is already up to date', async () => {
    await expect(runMigrations(ctx.db.ownerUrl)).resolves.toEqual([]);
  });

  it('apply each migration exactly once when several migrators start at the same time', async () => {
    const name = `ff_m_${randomBytes(6).toString('hex')}`;
    const admin = new Client({ connectionString: ctx.db.adminUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${name} TEMPLATE ${EMPTY_TEMPLATE_DB}`);
      const ownerUrl = withCredentials(withDatabase(ctx.db.adminUrl, name), DB_ROLES.owner);

      const results = await Promise.all([runMigrations(ownerUrl), runMigrations(ownerUrl), runMigrations(ownerUrl)]);

      expect(results.flat().sort()).toEqual(migrations.map((migration) => migration.name).sort());
      const fresh = new Client({ connectionString: withDatabase(ctx.db.adminUrl, name) });
      await fresh.connect();
      try {
        const { rows } = await fresh.query('SELECT name FROM migrations');
        expect(rows).toHaveLength(migrations.length);
      } finally {
        await fresh.end();
      }
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  });
});

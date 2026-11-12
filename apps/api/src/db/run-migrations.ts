import { DataSource } from 'typeorm';
import { DatabaseTimeouts, dataSourceOptions } from './data-source';

const MIGRATION_LOCK_KEY = 4_204_242_001;

export const DEFAULT_MIGRATION_TIMEOUTS: Required<DatabaseTimeouts> = {
  connectTimeoutMs: 5_000,
  statementTimeoutMs: 600_000,
  lockTimeoutMs: 5_000,
};

export async function runMigrations(url: string, timeouts: Required<DatabaseTimeouts> = DEFAULT_MIGRATION_TIMEOUTS): Promise<string[]> {
  const dataSource = await new DataSource(dataSourceOptions(url, timeouts)).initialize();
  const lock = dataSource.createQueryRunner();
  try {
    await lock.connect();
    await lock.query(`SET lock_timeout = 0`);
    await lock.query(`SET statement_timeout = 0`);
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      const applied = await dataSource.runMigrations({ transaction: 'each' });
      return applied.map((migration) => migration.name);
    } finally {
      await lock.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    await lock.release();
    await dataSource.destroy();
  }
}

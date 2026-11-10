import { DataSource } from 'typeorm';
import { dataSourceOptions } from './data-source';

const MIGRATION_LOCK_KEY = 4_204_242_001;

export async function runMigrations(url: string): Promise<string[]> {
  const dataSource = await new DataSource(dataSourceOptions(url)).initialize();
  const lock = dataSource.createQueryRunner();
  try {
    await lock.connect();
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

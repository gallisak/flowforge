import { loadConfigOrExit, loadMigrationConfig } from './config/config';
import { runMigrations } from './db/run-migrations';

async function migrate() {
  const config = loadConfigOrExit(() => loadMigrationConfig());
  const applied = await runMigrations(config.migrationDatabaseUrl);
  console.log(applied.length > 0 ? `applied migrations: ${applied.join(', ')}` : 'database schema is up to date');
}

migrate().catch((error: Error) => {
  process.stderr.write(`migration failed: ${error.message}\n`);
  process.exit(1);
});

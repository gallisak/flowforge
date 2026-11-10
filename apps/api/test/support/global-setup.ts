import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { postgresContainerRegistry } from './container';
import { EMPTY_TEMPLATE_DB, prepareTemplates, PROVISION_SQL, PROVISION_SQL_IN_CONTAINER, TEMPLATE_DB } from './schema';

export default async function globalSetup(): Promise<void> {
  let adminUrl = process.env.TEST_DATABASE_URL;

  if (!adminUrl) {
    const container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('postgres')
      .withUsername('flowforge')
      .withPassword('flowforge')
      .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
      .withCopyFilesToContainer([{ source: PROVISION_SQL, target: PROVISION_SQL_IN_CONTAINER }])
      .withCommand([
        'postgres',
        '-c', 'fsync=off',
        '-c', 'synchronous_commit=off',
        '-c', 'full_page_writes=off',
        '-c', 'max_connections=500',
      ])
      .start();
    postgresContainerRegistry.flowforgeTestPostgres = container;
    adminUrl = container.getConnectionUri();
  }

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    for (const template of [TEMPLATE_DB, EMPTY_TEMPLATE_DB]) {
      await admin.query(`DROP DATABASE IF EXISTS ${template} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${template}`);
    }
  } finally {
    await admin.end();
  }

  await prepareTemplates(adminUrl);

  process.env.FF_TEST_ADMIN_URL = adminUrl;
}

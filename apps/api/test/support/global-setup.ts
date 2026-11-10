import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { postgresContainerRegistry } from './container';
import { prepareTemplate, TEMPLATE_DB, withDatabase } from './schema';

export default async function globalSetup(): Promise<void> {
  let adminUrl = process.env.TEST_DATABASE_URL;

  if (!adminUrl) {
    const container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('postgres')
      .withUsername('flowforge')
      .withPassword('flowforge')
      .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
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
    await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }

  await prepareTemplate(withDatabase(adminUrl, TEMPLATE_DB));

  process.env.FF_TEST_ADMIN_URL = adminUrl;
}

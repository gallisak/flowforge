import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { postgresContainerRegistry } from './container';
import { EMPTY_TEMPLATE_DB, prepareTemplates, PROVISION_SQL, PROVISION_SQL_IN_CONTAINER, TEMPLATE_DB } from './schema';

const CONNECT_ATTEMPTS = 30;
const CONNECT_RETRY_DELAY_MS = 200;

async function connectWhenReady(url: string): Promise<Client> {
  for (let attempt = 1; ; attempt++) {
    const client = new Client({ connectionString: url });
    try {
      await client.connect();
      await client.query('SELECT 1');
      return client;
    } catch (error) {
      await client.end().catch(() => undefined);
      if (attempt >= CONNECT_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_DELAY_MS));
    }
  }
}

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

  const admin = await connectWhenReady(adminUrl);
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

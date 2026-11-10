import { randomBytes } from 'crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { entities } from '../../src/app.module';
import { hashApiKey } from '../../src/auth/api-key.guard';
import { StepDefinition, Tenant, Workflow } from '../../src/entities';
import { TEMPLATE_DB, withDatabase } from './schema';

export interface TestDatabase {
  name: string;
  url: string;
  drop(): Promise<void>;
}

function adminUrl(): string {
  const url = process.env.FF_TEST_ADMIN_URL;
  if (!url) throw new Error('FF_TEST_ADMIN_URL is not set: run integration tests with `npm run test:int`');
  return url;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `ff_t_${randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }
  return {
    name,
    url: withDatabase(adminUrl(), name),
    async drop() {
      const c = new Client({ connectionString: adminUrl() });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}

export async function openDataSource(url: string): Promise<DataSource> {
  const ds = new DataSource({ type: 'postgres', url, entities, synchronize: false });
  return ds.initialize();
}

export interface SeededTenant {
  tenant: Tenant;
  apiKey: string;
}

export async function seedTenant(ds: DataSource, name = 'acme'): Promise<SeededTenant> {
  const apiKey = `ff_test_${randomBytes(16).toString('hex')}`;
  const repo = ds.getRepository(Tenant);
  const tenant = await repo.save(
    repo.create({ name, apiKeyHash: hashApiKey(apiKey), webhookSecret: randomBytes(24).toString('hex') }),
  );
  return { tenant, apiKey };
}

export async function seedWorkflow(
  ds: DataSource,
  tenantId: string,
  steps: StepDefinition[],
  extra: Partial<Workflow> = {},
): Promise<Workflow> {
  const repo = ds.getRepository(Workflow);
  return repo.save(repo.create({ tenantId, name: 'test-workflow', steps, ...extra }));
}

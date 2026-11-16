import { Client } from 'pg';
import { QueryRunner } from 'typeorm';
import { IdleTenantClaims1794322400000 } from '../../src/migrations/1794322400000-idle-tenant-claims';
import { postgresContainerRegistry } from '../support/container';
import { createTestDatabase } from '../support/db';
import globalSetup from '../support/global-setup';

const IDLE_TENANTS = Number(process.env.IDLE_TENANTS ?? 5_000);
const CLAIMS = Number(process.env.CLAIMS ?? 200);

type Version = 'previous' | 'current';

async function seedIdleTenants(client: Client): Promise<void> {
  await client.query(`
    CREATE TEMP TABLE load_tenants AS
    SELECT gen_random_uuid() AS "tenantId", gen_random_uuid() AS "workflowId", gen_random_uuid() AS "executionId", n
      FROM generate_series(1, ${IDLE_TENANTS}) n`);
  await client.query(`
    INSERT INTO "tenants" ("id", "name", "apiKeyHash")
    SELECT "tenantId", 'idle ' || n, encode(sha256(convert_to("tenantId"::text, 'UTF8')), 'hex') FROM load_tenants`);
  await client.query(`
    INSERT INTO "workflows" ("id", "tenantId", "name", "steps")
    SELECT "workflowId", "tenantId", 'idle ' || n, '[{"id":"note","type":"log","message":"x"}]'::jsonb FROM load_tenants`);
  await client.query(`
    INSERT INTO "executions" ("id", "tenantId", "workflowId", "input", "trigger")
    SELECT "executionId", "tenantId", "workflowId", '{}'::jsonb, 'api' FROM load_tenants`);
  await client.query(`INSERT INTO "tenant_queue_state" ("tenantId") SELECT "tenantId" FROM load_tenants ON CONFLICT DO NOTHING`);
  await client.query(`
    INSERT INTO "jobs" ("tenantId", "executionId", "runAt")
    SELECT "tenantId", "executionId", now() + interval '1 hour' FROM load_tenants`);
}

async function measure(version: Version): Promise<number[]> {
  const db = await createTestDatabase();
  const client = new Client({ connectionString: db.adminUrl });
  await client.connect();
  try {
    if (version === 'previous') {
      const runner = { query: (sql: string) => client.query(sql) } as unknown as QueryRunner;
      await new IdleTenantClaims1794322400000().down(runner);
    }
    await seedIdleTenants(client);
    const claim = () => client.query(`SELECT * FROM claim_job('load-idle-claims', 30)`);
    await claim();
    for (const table of ['tenants', 'jobs', 'tenant_queue_state']) await client.query(`VACUUM ANALYZE "${table}"`);
    const timings: number[] = [];
    for (let i = 0; i < CLAIMS; i++) {
      const started = performance.now();
      await claim();
      timings.push(performance.now() - started);
    }
    return timings.sort((a, b) => a - b);
  } finally {
    await client.end();
    await db.drop();
  }
}

function percentile(sorted: number[], p: number): string {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)].toFixed(1);
}

async function main(): Promise<void> {
  await globalSetup();
  try {
    process.stdout.write(`${IDLE_TENANTS} tenants whose only job is due in an hour; one warm-up claim, then ${CLAIMS} measured claims\n`);
    process.stdout.write('| claim_job | p50, ms | p95, ms |\n|---|---|---|\n');
    for (const version of ['previous', 'current'] as const) {
      const timings = await measure(version);
      process.stdout.write(`| ${version} | ${percentile(timings, 50)} | ${percentile(timings, 95)} |\n`);
    }
  } finally {
    await postgresContainerRegistry.flowforgeTestPostgres?.stop();
  }
}

main().catch((error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});

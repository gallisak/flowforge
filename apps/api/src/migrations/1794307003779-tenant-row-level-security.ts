import { MigrationInterface, QueryRunner } from 'typeorm';

const TENANT_TABLES: ReadonlyArray<{ table: string; tenantColumn: string }> = [
  { table: 'tenants', tenantColumn: 'id' },
  { table: 'workflows', tenantColumn: 'tenantId' },
  { table: 'executions', tenantColumn: 'tenantId' },
  { table: 'step_runs', tenantColumn: 'tenantId' },
  { table: 'jobs', tenantColumn: 'tenantId' },
];

const SYSTEM_FUNCTIONS = [
  'auth_tenant(text)',
  'resolve_webhook_tenant(uuid)',
  'list_scheduled_workflows()',
  'next_ready_job()',
];

export class TenantRowLevelSecurity1794307003779 implements MigrationInterface {
  name = 'TenantRowLevelSecurity1794307003779';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "step_runs" ADD COLUMN "tenantId" uuid`);
    await queryRunner.query(`
      UPDATE "step_runs" s SET "tenantId" = e."tenantId"
        FROM "executions" e
       WHERE e."id" = s."executionId"
    `);
    await queryRunner.query(`ALTER TABLE "step_runs" ALTER COLUMN "tenantId" SET NOT NULL`);

    await queryRunner.query(`
      CREATE FUNCTION app_current_tenant() RETURNS uuid
        LANGUAGE sql STABLE
        AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$
    `);

    for (const { table, tenantColumn } of TENANT_TABLES) {
      await queryRunner.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      await queryRunner.query(`
        CREATE POLICY "tenant_isolation" ON "${table}"
          USING ("${tenantColumn}" = app_current_tenant())
          WITH CHECK ("${tenantColumn}" = app_current_tenant())
      `);
    }

    await queryRunner.query(`
      CREATE FUNCTION auth_tenant(p_api_key_hash text)
        RETURNS TABLE ("id" uuid, "name" character varying)
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
        AS $$ SELECT t."id", t."name" FROM "tenants" t WHERE t."apiKeyHash" = p_api_key_hash $$
    `);
    await queryRunner.query(`
      CREATE FUNCTION resolve_webhook_tenant(p_workflow_id uuid)
        RETURNS uuid
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
        AS $$ SELECT w."tenantId" FROM "workflows" w WHERE w."id" = p_workflow_id $$
    `);
    await queryRunner.query(`
      CREATE FUNCTION list_scheduled_workflows()
        RETURNS TABLE ("id" uuid, "tenantId" uuid, "cron" character varying, "timezone" character varying)
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
        AS $$
          SELECT w."id", w."tenantId", w."cron", w."timezone"
            FROM "workflows" w
           WHERE w."enabled" = true AND w."cron" IS NOT NULL
        $$
    `);
    await queryRunner.query(`
      CREATE FUNCTION next_ready_job()
        RETURNS TABLE ("id" uuid, "tenantId" uuid)
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
        AS $$
          SELECT j."id", j."tenantId"
            FROM "jobs" j
           WHERE j."status" = 'queued' AND j."runAt" <= now()
           ORDER BY j."runAt"
           LIMIT 1
        $$
    `);
    for (const fn of SYSTEM_FUNCTIONS) {
      await queryRunner.query(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC`);
      await queryRunner.query(`GRANT EXECUTE ON FUNCTION ${fn} TO flowforge_app`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const fn of SYSTEM_FUNCTIONS) {
      await queryRunner.query(`DROP FUNCTION ${fn}`);
    }
    for (const { table } of TENANT_TABLES) {
      await queryRunner.query(`DROP POLICY "tenant_isolation" ON "${table}"`);
      await queryRunner.query(`ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY`);
    }
    await queryRunner.query(`DROP FUNCTION app_current_tenant()`);
    await queryRunner.query(`ALTER TABLE "step_runs" DROP COLUMN "tenantId"`);
  }
}

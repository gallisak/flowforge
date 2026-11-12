import { MigrationInterface, QueryRunner } from 'typeorm';

export class LeastPrivilegeGrants1794321600000 implements MigrationInterface {
  name = 'LeastPrivilegeGrants1794321600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`REVOKE ALL ON TABLE "migrations" FROM flowforge_app`);
    await queryRunner.query(`REVOKE ALL ON SEQUENCE "migrations_id_seq" FROM flowforge_app`);
    await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "workflow_versions" FROM flowforge_app`);
    await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "tenants" FROM flowforge_app`);
    await queryRunner.query(`
      CREATE FUNCTION set_tenant_limits(p_tenant_id uuid, p_changes jsonb)
        RETURNS TABLE ("id" uuid, "maxConcurrentJobs" integer, "maxQueuedJobs" integer, "rateLimitPerMinute" integer)
        LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
        AS $$
          UPDATE "tenants" t
             SET "maxConcurrentJobs" = CASE WHEN p_changes ? 'maxConcurrentJobs' THEN (p_changes ->> 'maxConcurrentJobs')::integer ELSE t."maxConcurrentJobs" END,
                 "maxQueuedJobs" = CASE WHEN p_changes ? 'maxQueuedJobs' THEN (p_changes ->> 'maxQueuedJobs')::integer ELSE t."maxQueuedJobs" END,
                 "rateLimitPerMinute" = CASE WHEN p_changes ? 'rateLimitPerMinute' THEN (p_changes ->> 'rateLimitPerMinute')::integer ELSE t."rateLimitPerMinute" END
           WHERE t."id" = p_tenant_id
          RETURNING t."id", t."maxConcurrentJobs", t."maxQueuedJobs", t."rateLimitPerMinute"
        $$
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION set_tenant_limits(uuid, jsonb) FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION set_tenant_limits(uuid, jsonb) TO flowforge_app`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION set_tenant_limits(uuid, jsonb)`);
    await queryRunner.query(`GRANT UPDATE, DELETE, TRUNCATE ON TABLE "tenants" TO flowforge_app`);
    await queryRunner.query(`GRANT UPDATE, DELETE, TRUNCATE ON TABLE "workflow_versions" TO flowforge_app`);
    await queryRunner.query(`GRANT USAGE, SELECT ON SEQUENCE "migrations_id_seq" TO flowforge_app`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "migrations" TO flowforge_app`);
  }
}

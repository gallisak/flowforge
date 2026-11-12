import { MigrationInterface, QueryRunner } from 'typeorm';

export const TENANT_LIMITS_CHECK = [
  '("maxConcurrentJobs" IS NULL OR "maxConcurrentJobs" BETWEEN 1 AND 10000)',
  '("maxQueuedJobs" IS NULL OR "maxQueuedJobs" BETWEEN 1 AND 10000000)',
  '("rateLimitPerMinute" IS NULL OR "rateLimitPerMinute" BETWEEN 1 AND 1000000)',
].join(' AND ');

export class TenantLimitChecks1794322000000 implements MigrationInterface {
  name = 'TenantLimitChecks1794322000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "tenants"
         SET "maxConcurrentJobs" = CASE WHEN "maxConcurrentJobs" BETWEEN 1 AND 10000 THEN "maxConcurrentJobs" END,
             "maxQueuedJobs" = CASE WHEN "maxQueuedJobs" BETWEEN 1 AND 10000000 THEN "maxQueuedJobs" END,
             "rateLimitPerMinute" = CASE WHEN "rateLimitPerMinute" BETWEEN 1 AND 1000000 THEN "rateLimitPerMinute" END
       WHERE NOT (${TENANT_LIMITS_CHECK})
    `);
    await queryRunner.query(`ALTER TABLE "tenants" ADD CONSTRAINT "CHK_tenants_limits" CHECK (${TENANT_LIMITS_CHECK})`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tenants" DROP CONSTRAINT "CHK_tenants_limits"`);
  }
}

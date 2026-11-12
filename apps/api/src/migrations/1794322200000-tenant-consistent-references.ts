import { MigrationInterface, QueryRunner } from 'typeorm';

export const EXECUTION_REFERENCES = [
  { table: 'step_runs', constraint: 'FK_step_runs_execution' },
  { table: 'jobs', constraint: 'FK_jobs_execution' },
  { table: 'outbox_events', constraint: 'FK_outbox_events_execution' },
] as const;

export class TenantConsistentReferences1794322200000 implements MigrationInterface {
  name = 'TenantConsistentReferences1794322200000';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_executions_tenant_id" ON "executions" ("tenantId", "id")`);
    await queryRunner.query(`ALTER TABLE "executions" ADD CONSTRAINT "UQ_executions_tenant_id" UNIQUE USING INDEX "UQ_executions_tenant_id"`);
    for (const { table, constraint } of EXECUTION_REFERENCES) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${constraint}" FOREIGN KEY ("tenantId", "executionId")
           REFERENCES "executions" ("tenantId", "id") ON DELETE CASCADE NOT VALID`,
      );
      await queryRunner.query(`ALTER TABLE "${table}" VALIDATE CONSTRAINT "${constraint}"`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const { table, constraint } of EXECUTION_REFERENCES) {
      await queryRunner.query(`ALTER TABLE "${table}" DROP CONSTRAINT "${constraint}"`);
    }
    await queryRunner.query(`ALTER TABLE "executions" DROP CONSTRAINT "UQ_executions_tenant_id"`);
  }
}

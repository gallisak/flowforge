import { MigrationInterface, QueryRunner } from 'typeorm';

export class ExecutionWorkflowStatistics1794321100000 implements MigrationInterface {
  name = 'ExecutionWorkflowStatistics1794321100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE STATISTICS "STAT_executions_tenant_workflow" (dependencies) ON "tenantId", "workflowId" FROM "executions"`);
    await queryRunner.query(`ANALYZE "executions"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP STATISTICS "STAT_executions_tenant_workflow"`);
  }
}

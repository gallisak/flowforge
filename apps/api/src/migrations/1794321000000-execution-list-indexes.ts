import { MigrationInterface, QueryRunner } from 'typeorm';

export class ExecutionListIndexes1794321000000 implements MigrationInterface {
  name = 'ExecutionListIndexes1794321000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX "IDX_executions_tenant_created" ON "executions" ("tenantId", "createdAt", "id")`);
    await queryRunner.query(`CREATE INDEX "IDX_executions_tenant_status_created" ON "executions" ("tenantId", "status", "createdAt", "id")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_executions_tenant_workflow_created" ON "executions" ("tenantId", "workflowId", "createdAt", "id")`,
    );
    await queryRunner.query(`DROP INDEX "IDX_5b883cccfe558d00b8a9319d93"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX "IDX_5b883cccfe558d00b8a9319d93" ON "executions" ("tenantId", "createdAt")`);
    await queryRunner.query(`DROP INDEX "IDX_executions_tenant_workflow_created"`);
    await queryRunner.query(`DROP INDEX "IDX_executions_tenant_status_created"`);
    await queryRunner.query(`DROP INDEX "IDX_executions_tenant_created"`);
  }
}

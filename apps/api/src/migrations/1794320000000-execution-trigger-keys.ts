import { MigrationInterface, QueryRunner } from 'typeorm';

export class ExecutionTriggerKeys1794320000000 implements MigrationInterface {
  name = 'ExecutionTriggerKeys1794320000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "executions" ADD "triggerKey" character varying(300)`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_executions_tenant_trigger_key" ON "executions" ("tenantId", "triggerKey") WHERE "triggerKey" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "UQ_executions_tenant_trigger_key"`);
    await queryRunner.query(`ALTER TABLE "executions" DROP COLUMN "triggerKey"`);
  }
}

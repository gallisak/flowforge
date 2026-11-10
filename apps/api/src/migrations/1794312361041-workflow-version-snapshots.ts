import { MigrationInterface, QueryRunner } from 'typeorm';

export class WorkflowVersionSnapshots1794312361041 implements MigrationInterface {
  name = 'WorkflowVersionSnapshots1794312361041';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "workflow_versions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "workflowId" uuid NOT NULL,
        "version" integer NOT NULL,
        "steps" jsonb NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_a84eb8dc6065f33ce4b1447955f" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_workflow_versions_workflow_version" ON "workflow_versions" ("workflowId", "version")`,
    );
    await queryRunner.query(`ALTER TABLE "workflow_versions" ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY "tenant_isolation" ON "workflow_versions"
        USING ("tenantId" = app_current_tenant())
        WITH CHECK ("tenantId" = app_current_tenant())
    `);
    await queryRunner.query(`
      INSERT INTO "workflow_versions" ("tenantId", "workflowId", "version", "steps")
      SELECT w."tenantId", w."id", w."version", w."steps" FROM "workflows" w
    `);

    await queryRunner.query(`ALTER TABLE "executions" ADD "workflowVersion" integer NOT NULL DEFAULT '1'`);
    await queryRunner.query(`
      UPDATE "executions" e SET "workflowVersion" = w."version"
        FROM "workflows" w
       WHERE w."id" = e."workflowId"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "executions" DROP COLUMN "workflowVersion"`);
    await queryRunner.query(`DROP TABLE "workflow_versions"`);
  }
}

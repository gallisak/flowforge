import { MigrationInterface, QueryRunner } from 'typeorm';

async function createIndexConcurrently(queryRunner: QueryRunner, name: string, definition: string): Promise<void> {
  const [index]: Array<{ valid: boolean }> = await queryRunner.query(
    `SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass($1)`,
    [`public."${name}"`],
  );
  if (index && !index.valid) await queryRunner.query(`DROP INDEX CONCURRENTLY "${name}"`);
  await queryRunner.query(`CREATE ${definition.startsWith('UNIQUE') ? 'UNIQUE INDEX' : 'INDEX'} CONCURRENTLY IF NOT EXISTS "${name}" ${definition.replace(/^UNIQUE /, '')}`);
}

export class TenantScopedVersionIndex1794322800000 implements MigrationInterface {
  name = 'TenantScopedVersionIndex1794322800000';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await createIndexConcurrently(
      queryRunner,
      'UQ_workflow_versions_tenant_workflow_version',
      'UNIQUE ON "workflow_versions" ("tenantId", "workflowId", "version")',
    );
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "UQ_workflow_versions_workflow_version"`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "IDX_50b693c75be8214931a320c923"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_50b693c75be8214931a320c923" ON "workflows" ("tenantId")`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_workflow_versions_workflow_version" ON "workflow_versions" ("workflowId", "version")`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_workflow_versions_tenant_workflow_version"`);
  }
}

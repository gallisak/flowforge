import { MigrationInterface, QueryRunner } from 'typeorm';

export class WebhookSecretRotation1794320100000 implements MigrationInterface {
  name = 'WebhookSecretRotation1794320100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "webhook_secrets" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "secret" character varying NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "expiresAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_webhook_secrets_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_webhook_secrets_tenant" ON "webhook_secrets" ("tenantId")`);
    await queryRunner.query(`ALTER TABLE "webhook_secrets" ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY "tenant_isolation" ON "webhook_secrets"
        USING ("tenantId" = app_current_tenant())
        WITH CHECK ("tenantId" = app_current_tenant())
    `);
    await queryRunner.query(`
      INSERT INTO "webhook_secrets" ("tenantId", "secret", "createdAt")
      SELECT t."id", t."webhookSecret", t."createdAt" FROM "tenants" t
    `);
    await queryRunner.query(`ALTER TABLE "tenants" DROP COLUMN "webhookSecret"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tenants" ADD "webhookSecret" character varying`);
    await queryRunner.query(`
      UPDATE "tenants" t SET "webhookSecret" = (
        SELECT s."secret" FROM "webhook_secrets" s WHERE s."tenantId" = t."id" ORDER BY s."createdAt" DESC LIMIT 1
      )
    `);
    await queryRunner.query(`ALTER TABLE "tenants" ALTER COLUMN "webhookSecret" SET NOT NULL`);
    await queryRunner.query(`DROP TABLE "webhook_secrets"`);
  }
}

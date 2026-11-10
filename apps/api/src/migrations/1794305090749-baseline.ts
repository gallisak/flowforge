import { MigrationInterface, QueryRunner } from 'typeorm';

export class Baseline1794305090749 implements MigrationInterface {
  name = 'Baseline1794305090749';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "tenants" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" character varying NOT NULL,
        "apiKeyHash" character varying NOT NULL,
        "webhookSecret" character varying NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_709d3381113f521a1900eca4b33" UNIQUE ("apiKeyHash"),
        CONSTRAINT "PK_53be67a04681c66b87ee27c9321" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "workflows" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "name" character varying NOT NULL,
        "steps" jsonb NOT NULL,
        "enabled" boolean NOT NULL DEFAULT true,
        "cron" character varying,
        "timezone" character varying NOT NULL DEFAULT 'UTC',
        "version" integer NOT NULL DEFAULT '1',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_5b5757cc1cd86268019fef52e0c" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_50b693c75be8214931a320c923" ON "workflows" ("tenantId")`);
    await queryRunner.query(`
      CREATE TABLE "executions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "workflowId" uuid NOT NULL,
        "status" character varying NOT NULL DEFAULT 'pending',
        "input" jsonb NOT NULL DEFAULT '{}',
        "output" jsonb,
        "error" text,
        "trigger" character varying NOT NULL DEFAULT 'api',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "finishedAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_703e64e0ef651986191844b7b8b" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_5b883cccfe558d00b8a9319d93" ON "executions" ("tenantId", "createdAt")`);
    await queryRunner.query(`
      CREATE TABLE "step_runs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "executionId" uuid NOT NULL,
        "stepIndex" integer NOT NULL,
        "stepId" character varying NOT NULL,
        "status" character varying NOT NULL DEFAULT 'running',
        "output" jsonb,
        "error" text,
        "startedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_5786a3a2b02a77b446ce02c4c09" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_26dad67b58b319f33770f4adce" ON "step_runs" ("executionId", "stepIndex")`);
    await queryRunner.query(`
      CREATE TABLE "jobs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "executionId" uuid NOT NULL,
        "status" character varying NOT NULL DEFAULT 'queued',
        "runAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "attempts" integer NOT NULL DEFAULT '0',
        "maxAttempts" integer NOT NULL DEFAULT '3',
        "lockedBy" character varying,
        "lockedUntil" TIMESTAMP WITH TIME ZONE,
        "lastError" text,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_cf0a6c42b72fcc7f7c237def345" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_f0517eec3f63f617ee5138edeb" ON "jobs" ("status", "runAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "jobs"`);
    await queryRunner.query(`DROP TABLE "step_runs"`);
    await queryRunner.query(`DROP TABLE "executions"`);
    await queryRunner.query(`DROP TABLE "workflows"`);
    await queryRunner.query(`DROP TABLE "tenants"`);
  }
}

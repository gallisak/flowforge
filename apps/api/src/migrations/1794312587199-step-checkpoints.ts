import { MigrationInterface, QueryRunner } from 'typeorm';

export class StepCheckpoints1794312587199 implements MigrationInterface {
  name = 'StepCheckpoints1794312587199';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "step_runs" ADD "attempts" integer NOT NULL DEFAULT '0'`);
    await queryRunner.query(`ALTER TABLE "step_runs" ADD "finishedAt" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`
      WITH ranked AS (
        SELECT s."id",
               count(*) OVER (PARTITION BY s."executionId", s."stepIndex") AS "attempts",
               row_number() OVER (
                 PARTITION BY s."executionId", s."stepIndex"
                 ORDER BY (s."status" = 'succeeded') DESC, s."startedAt" DESC, s."id"
               ) AS "rank"
          FROM "step_runs" s
      ),
      kept AS (
        UPDATE "step_runs" s SET "attempts" = ranked."attempts"
          FROM ranked
         WHERE ranked."id" = s."id" AND ranked."rank" = 1
      )
      DELETE FROM "step_runs" s USING ranked WHERE ranked."id" = s."id" AND ranked."rank" > 1
    `);
    await queryRunner.query(`DROP INDEX "public"."IDX_26dad67b58b319f33770f4adce"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_step_runs_execution_step" ON "step_runs" ("executionId", "stepIndex")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."UQ_step_runs_execution_step"`);
    await queryRunner.query(`CREATE INDEX "IDX_26dad67b58b319f33770f4adce" ON "step_runs" ("executionId", "stepIndex")`);
    await queryRunner.query(`ALTER TABLE "step_runs" DROP COLUMN "finishedAt"`);
    await queryRunner.query(`ALTER TABLE "step_runs" DROP COLUMN "attempts"`);
  }
}

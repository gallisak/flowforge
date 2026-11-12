import { MigrationInterface, QueryRunner } from 'typeorm';

const DUE_SCHEDULE_COLUMNS = `
  "id" uuid, "tenantId" uuid, "cron" character varying, "timezone" character varying,
  "nextRunAt" timestamptz, "missedRunPolicy" character varying
`;

export class PostponedSchedules1794321400000 implements MigrationInterface {
  name = 'PostponedSchedules1794321400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "workflows" ADD "scheduleRetryAt" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`DROP INDEX "IDX_workflows_next_run_at"`);
    await queryRunner.query(
      `CREATE INDEX "IDX_workflows_due" ON "workflows" ((COALESCE("scheduleRetryAt", "nextRunAt"))) WHERE "nextRunAt" IS NOT NULL`,
    );
    await queryRunner.query(`DROP FUNCTION claim_due_schedule(timestamptz, uuid[])`);
    await queryRunner.query(`
      CREATE FUNCTION claim_due_schedule(p_now timestamptz)
        RETURNS TABLE (${DUE_SCHEDULE_COLUMNS})
        LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
        AS $$
          SELECT w."id", w."tenantId", w."cron", w."timezone", w."nextRunAt", w."missedRunPolicy"
            FROM "workflows" w
           WHERE w."nextRunAt" IS NOT NULL
             AND COALESCE(w."scheduleRetryAt", w."nextRunAt") <= p_now
             AND w."enabled" = true
             AND w."cron" IS NOT NULL
           ORDER BY COALESCE(w."scheduleRetryAt", w."nextRunAt")
           LIMIT 1
             FOR UPDATE SKIP LOCKED
        $$
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION claim_due_schedule(timestamptz) FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION claim_due_schedule(timestamptz) TO flowforge_app`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION claim_due_schedule(timestamptz)`);
    await queryRunner.query(`
      CREATE FUNCTION claim_due_schedule(p_now timestamptz, p_skip uuid[])
        RETURNS TABLE (${DUE_SCHEDULE_COLUMNS})
        LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
        AS $$
          SELECT w."id", w."tenantId", w."cron", w."timezone", w."nextRunAt", w."missedRunPolicy"
            FROM "workflows" w
           WHERE w."nextRunAt" <= p_now
             AND w."enabled" = true
             AND w."cron" IS NOT NULL
             AND w."id" <> ALL (p_skip)
           ORDER BY w."nextRunAt"
           LIMIT 1
             FOR UPDATE SKIP LOCKED
        $$
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION claim_due_schedule(timestamptz, uuid[]) FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION claim_due_schedule(timestamptz, uuid[]) TO flowforge_app`);
    await queryRunner.query(`DROP INDEX "IDX_workflows_due"`);
    await queryRunner.query(`CREATE INDEX "IDX_workflows_next_run_at" ON "workflows" ("nextRunAt") WHERE "nextRunAt" IS NOT NULL`);
    await queryRunner.query(`ALTER TABLE "workflows" DROP COLUMN "scheduleRetryAt"`);
  }
}

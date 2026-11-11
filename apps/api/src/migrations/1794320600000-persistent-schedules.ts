import { MigrationInterface, QueryRunner } from 'typeorm';
import { nextOccurrence } from '../scheduler/cron-schedule';

export class PersistentSchedules1794320600000 implements MigrationInterface {
  name = 'PersistentSchedules1794320600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "workflows" ADD "nextRunAt" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(
      `ALTER TABLE "workflows" ADD "missedRunPolicy" character varying(8) NOT NULL DEFAULT 'once'
         CONSTRAINT "CHK_workflows_missed_run_policy" CHECK ("missedRunPolicy" IN ('skip', 'once', 'all'))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_workflows_next_run_at" ON "workflows" ("nextRunAt") WHERE "nextRunAt" IS NOT NULL`);

    const scheduled: Array<{ id: string; cron: string; timezone: string }> = await queryRunner.query(
      `SELECT "id", "cron", "timezone" FROM "workflows" WHERE "enabled" = true AND "cron" IS NOT NULL`,
    );
    const now = new Date();
    for (const workflow of scheduled) {
      let nextRunAt: Date | null = null;
      try {
        nextRunAt = nextOccurrence(workflow, now);
      } catch {
        nextRunAt = null;
      }
      await queryRunner.query(`UPDATE "workflows" SET "nextRunAt" = $1 WHERE "id" = $2`, [nextRunAt, workflow.id]);
    }

    await queryRunner.query(`DROP FUNCTION list_scheduled_workflows()`);
    await queryRunner.query(`
      CREATE FUNCTION list_due_schedules(p_now timestamptz)
        RETURNS TABLE (
          "id" uuid, "tenantId" uuid, "cron" character varying, "timezone" character varying,
          "nextRunAt" timestamptz, "missedRunPolicy" character varying
        )
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
        AS $$
          SELECT w."id", w."tenantId", w."cron", w."timezone", w."nextRunAt", w."missedRunPolicy"
            FROM "workflows" w
           WHERE w."nextRunAt" <= p_now AND w."enabled" = true AND w."cron" IS NOT NULL
           ORDER BY w."nextRunAt"
        $$
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION list_due_schedules(timestamptz) FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION list_due_schedules(timestamptz) TO flowforge_app`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION list_due_schedules(timestamptz)`);
    await queryRunner.query(`
      CREATE FUNCTION list_scheduled_workflows()
        RETURNS TABLE ("id" uuid, "tenantId" uuid, "cron" character varying, "timezone" character varying)
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
        AS $$
          SELECT w."id", w."tenantId", w."cron", w."timezone"
            FROM "workflows" w
           WHERE w."enabled" = true AND w."cron" IS NOT NULL
        $$
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION list_scheduled_workflows() FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION list_scheduled_workflows() TO flowforge_app`);
    await queryRunner.query(`DROP INDEX "IDX_workflows_next_run_at"`);
    await queryRunner.query(`ALTER TABLE "workflows" DROP COLUMN "missedRunPolicy"`);
    await queryRunner.query(`ALTER TABLE "workflows" DROP COLUMN "nextRunAt"`);
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

const DUE_SCHEDULE_COLUMNS = `
  "id" uuid, "tenantId" uuid, "cron" character varying, "timezone" character varying,
  "nextRunAt" timestamptz, "missedRunPolicy" character varying
`;

export class ClaimDueSchedules1794320700000 implements MigrationInterface {
  name = 'ClaimDueSchedules1794320700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION list_due_schedules(timestamptz)`);
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
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION claim_due_schedule(timestamptz, uuid[])`);
    await queryRunner.query(`
      CREATE FUNCTION list_due_schedules(p_now timestamptz)
        RETURNS TABLE (${DUE_SCHEDULE_COLUMNS})
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
}

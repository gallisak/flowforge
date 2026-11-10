import { MigrationInterface, QueryRunner } from 'typeorm';

export class JobLeaseRecovery1794308604391 implements MigrationInterface {
  name = 'JobLeaseRecovery1794308604391';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION reap_expired_jobs()
        RETURNS TABLE ("id" uuid, "tenantId" uuid, "executionId" uuid, "status" character varying, "attempts" integer)
        LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
        AS $$
          WITH expired AS (
            SELECT q."id"
              FROM "jobs" q
             WHERE q."status" = 'running' AND q."lockedUntil" < now()
               FOR UPDATE SKIP LOCKED
          )
          UPDATE "jobs" j
             SET "status" = CASE WHEN j."attempts" >= j."maxAttempts" THEN 'dead' ELSE 'queued' END,
                 "lockedBy" = NULL,
                 "lockedUntil" = NULL,
                 "runAt" = now(),
                 "lastError" = 'lease expired: the worker stopped renewing its lease'
            FROM expired
           WHERE j."id" = expired."id"
          RETURNING j."id", j."tenantId", j."executionId", j."status", j."attempts"
        $$
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION reap_expired_jobs() FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION reap_expired_jobs() TO flowforge_app`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION reap_expired_jobs()`);
  }
}

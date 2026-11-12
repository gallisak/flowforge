import { MigrationInterface, QueryRunner } from 'typeorm';
import { REAPER_RESULT } from './1794320800000-execution-notifications';
import { EXPIRE_JOBS_AND_RELEASE_STATES, reaperFunction } from './1794321200000-reaper-releases-interrupted-steps';

const LEASE_EXPIRED = 'lease expired: the worker stopped renewing its lease';
export const PER_STEP_REAPER_SIGNATURE = 'reap_expired_jobs(integer, integer)';

const EXPIRE_JOBS_WITH_BACKOFF = `
  WITH expired AS (
    SELECT q."id"
      FROM "jobs" q
     WHERE q."status" = 'running' AND q."lockedUntil" < now()
       FOR UPDATE SKIP LOCKED
  ),
  reaped AS (
    UPDATE "jobs" j
       SET "status" = CASE WHEN j."attempts" - j."attemptsAtProgress" >= j."maxAttempts" THEN 'dead' ELSE 'queued' END,
           "lockedBy" = NULL,
           "lockedUntil" = NULL,
           "runAt" = now() + make_interval(secs => (
             p_retry_base_ms + random() * (least(p_retry_cap_ms, p_retry_base_ms * power(2, j."attempts" - j."attemptsAtProgress")) - p_retry_base_ms)
           ) / 1000.0),
           "lastError" = '${LEASE_EXPIRED}'
      FROM expired
     WHERE j."id" = expired."id"
    RETURNING j."id", j."tenantId", j."executionId", j."status", j."attempts", j."attempts" - j."attemptsAtProgress" AS "stepAttempts"
  ),
  requeued AS (
    UPDATE "executions" e
       SET "status" = 'pending',
           "error" = '${LEASE_EXPIRED}'
      FROM reaped
     WHERE reaped."status" = 'queued' AND e."id" = reaped."executionId" AND e."status" = 'running'
  ),
  failed AS (
    UPDATE "executions" e
       SET "status" = 'failed',
           "error" = '${LEASE_EXPIRED} (gave up after ' || reaped."stepAttempts" || ' attempts)',
           "finishedAt" = now()
      FROM reaped
     WHERE reaped."status" = 'dead' AND e."id" = reaped."executionId"
  ),
  interrupted AS (
    UPDATE "step_runs" s
       SET "status" = 'failed',
           "error" = '${LEASE_EXPIRED}',
           "finishedAt" = now()
      FROM reaped
     WHERE s."executionId" = reaped."executionId" AND s."status" = 'running'
  )
  SELECT * FROM reaped
`;

export const PER_STEP_REAPER = `
      CREATE FUNCTION reap_expired_jobs(p_retry_base_ms integer DEFAULT 1000, p_retry_cap_ms integer DEFAULT 300000)
        RETURNS TABLE ${REAPER_RESULT}
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
        AS $$
        DECLARE
          reaped_job record;
          dead_executions uuid[] := '{}';
        BEGIN
          FOR reaped_job IN ${EXPIRE_JOBS_WITH_BACKOFF}
          LOOP
            "id" := reaped_job."id";
            "tenantId" := reaped_job."tenantId";
            "executionId" := reaped_job."executionId";
            "status" := reaped_job."status";
            "attempts" := reaped_job."attempts";
            RETURN NEXT;
            IF reaped_job."status" = 'dead' THEN
              dead_executions := dead_executions || reaped_job."executionId";
            END IF;
          END LOOP;
          PERFORM record_execution_event(dead) FROM unnest(dead_executions) AS dead;
        END
        $$
    `;

export class PerStepAttempts1794321800000 implements MigrationInterface {
  name = 'PerStepAttempts1794321800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "jobs" ADD COLUMN "attemptsAtProgress" integer NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "jobs" ALTER COLUMN "maxAttempts" SET DEFAULT 8`);
    await queryRunner.query(`DROP FUNCTION reap_expired_jobs()`);
    await queryRunner.query(PER_STEP_REAPER);
    await queryRunner.query(`REVOKE ALL ON FUNCTION ${PER_STEP_REAPER_SIGNATURE} FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION ${PER_STEP_REAPER_SIGNATURE} TO flowforge_app`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION ${PER_STEP_REAPER_SIGNATURE}`);
    await queryRunner.query(reaperFunction(EXPIRE_JOBS_AND_RELEASE_STATES));
    await queryRunner.query(`REVOKE ALL ON FUNCTION reap_expired_jobs() FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION reap_expired_jobs() TO flowforge_app`);
    await queryRunner.query(`ALTER TABLE "jobs" ALTER COLUMN "maxAttempts" SET DEFAULT 3`);
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "attemptsAtProgress"`);
  }
}

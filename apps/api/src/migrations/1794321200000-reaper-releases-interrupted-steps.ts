import { MigrationInterface, QueryRunner } from 'typeorm';
import { EXPIRE_JOBS, REAPER_RESULT } from './1794320800000-execution-notifications';

const LEASE_EXPIRED = 'lease expired: the worker stopped renewing its lease';

export const EXPIRE_JOBS_AND_RELEASE_STATES = `
  WITH expired AS (
    SELECT q."id"
      FROM "jobs" q
     WHERE q."status" = 'running' AND q."lockedUntil" < now()
       FOR UPDATE SKIP LOCKED
  ),
  reaped AS (
    UPDATE "jobs" j
       SET "status" = CASE WHEN j."attempts" >= j."maxAttempts" THEN 'dead' ELSE 'queued' END,
           "lockedBy" = NULL,
           "lockedUntil" = NULL,
           "runAt" = now(),
           "lastError" = '${LEASE_EXPIRED}'
      FROM expired
     WHERE j."id" = expired."id"
    RETURNING j."id", j."tenantId", j."executionId", j."status", j."attempts"
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
           "error" = 'lease expired ' || reaped."attempts" || ' times: the job was abandoned by its worker on every attempt',
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

export function reaperFunction(expireJobs: string): string {
  return `
    CREATE OR REPLACE FUNCTION reap_expired_jobs()
      RETURNS TABLE ${REAPER_RESULT}
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
      AS $$
      DECLARE
        reaped_job record;
        dead_executions uuid[] := '{}';
      BEGIN
        FOR reaped_job IN ${expireJobs}
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
}

export class ReaperReleasesInterruptedSteps1794321200000 implements MigrationInterface {
  name = 'ReaperReleasesInterruptedSteps1794321200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(reaperFunction(EXPIRE_JOBS_AND_RELEASE_STATES));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(reaperFunction(EXPIRE_JOBS));
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

const REAPER_HEADER = `
  CREATE OR REPLACE FUNCTION reap_expired_jobs()
    RETURNS TABLE ("id" uuid, "tenantId" uuid, "executionId" uuid, "status" character varying, "attempts" integer)
    LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
`;

const EXPIRE_JOBS = `
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
           "lastError" = 'lease expired: the worker stopped renewing its lease'
      FROM expired
     WHERE j."id" = expired."id"
    RETURNING j."id", j."tenantId", j."executionId", j."status", j."attempts"
  )
`;

export class AtomicLeaseReaper1794311016857 implements MigrationInterface {
  name = 'AtomicLeaseReaper1794311016857';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ${REAPER_HEADER}
      AS $$
        ${EXPIRE_JOBS},
        failed AS (
          UPDATE "executions" e
             SET "status" = 'failed',
                 "error" = 'lease expired ' || reaped."attempts" || ' times: the job was abandoned by its worker on every attempt',
                 "finishedAt" = now()
            FROM reaped
           WHERE reaped."status" = 'dead' AND e."id" = reaped."executionId"
        )
        SELECT * FROM reaped
      $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ${REAPER_HEADER}
      AS $$
        ${EXPIRE_JOBS}
        SELECT * FROM reaped
      $$
    `);
  }
}

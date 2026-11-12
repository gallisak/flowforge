import { MigrationInterface, QueryRunner } from 'typeorm';
import { REAPER_RESULT } from './1794320800000-execution-notifications';
import { PER_STEP_REAPER, PER_STEP_REAPER_SIGNATURE } from './1794321800000-per-step-attempts';
import { WATCH_EXECUTION } from './1794321850000-watched-execution-notifications';
import { RETENTION_PURGE } from './1794321900000-data-retention';

const LEASE_EXPIRED = 'lease expired: the worker stopped renewing its lease';
const REAPER_SIGNATURE = 'reap_expired_jobs(integer, integer, integer)';
const PURGE_SIGNATURE = 'purge_finished_data(interval, integer)';
const WATCH_SIGNATURE = 'watch_execution(uuid, integer)';
const TRIGGER_FUNCTIONS = ['measure_output()', 'notify_execution_change()'];

const REAPER = `
  CREATE FUNCTION reap_expired_jobs(p_retry_base_ms integer DEFAULT 1000, p_retry_cap_ms integer DEFAULT 300000, p_batch integer DEFAULT 500)
    RETURNS TABLE ${REAPER_RESULT}
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    DECLARE
      reaped_job record;
      dead_executions uuid[] := '{}';
    BEGIN
      FOR reaped_job IN
        WITH expired AS (
          SELECT q."id"
            FROM "jobs" q
           WHERE q."status" = 'running' AND q."lockedUntil" < now()
           ORDER BY q."lockedUntil"
           LIMIT p_batch
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
           WHERE reaped."status" = 'queued' AND e."tenantId" = reaped."tenantId" AND e."id" = reaped."executionId" AND e."status" = 'running'
        ),
        failed AS (
          UPDATE "executions" e
             SET "status" = 'failed',
                 "error" = '${LEASE_EXPIRED} (gave up after ' || reaped."stepAttempts" || ' attempts)',
                 "finishedAt" = now()
            FROM reaped
           WHERE reaped."status" = 'dead' AND e."tenantId" = reaped."tenantId" AND e."id" = reaped."executionId"
        ),
        interrupted AS (
          UPDATE "step_runs" s
             SET "status" = 'failed',
                 "error" = '${LEASE_EXPIRED}',
                 "finishedAt" = now()
            FROM reaped
           WHERE s."tenantId" = reaped."tenantId" AND s."executionId" = reaped."executionId"
             AND (s."status" = 'running' OR (reaped."status" = 'dead' AND s."status" = 'waiting'))
        )
        SELECT * FROM reaped
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

const PURGE = `
  CREATE OR REPLACE FUNCTION purge_finished_data(p_retention interval, p_batch integer)
    RETURNS TABLE ("executions" integer, "outboxEvents" integer, "workflowVersions" integer)
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    DECLARE
      purged uuid[];
    BEGIN
      SELECT coalesce(array_agg(old."id"), '{}') INTO purged
        FROM (
          SELECT e."id"
            FROM "executions" e
           WHERE e."status" IN ('succeeded', 'failed')
             AND e."finishedAt" < now() - p_retention
             AND NOT EXISTS (
               SELECT 1 FROM "outbox_events" o
                WHERE o."tenantId" = e."tenantId" AND o."executionId" = e."id" AND o."status" IN ('pending', 'delivering')
             )
           ORDER BY e."finishedAt"
           LIMIT p_batch
             FOR UPDATE SKIP LOCKED
        ) old;
      DELETE FROM "executions" WHERE "id" = ANY (purged);
      "executions" := cardinality(purged);

      WITH old AS (
        SELECT o."id"
          FROM "outbox_events" o
         WHERE o."status" IN ('delivered', 'dead') AND o."createdAt" < now() - p_retention
         ORDER BY o."createdAt"
         LIMIT p_batch
           FOR UPDATE SKIP LOCKED
      )
      DELETE FROM "outbox_events" o USING old WHERE o."id" = old."id";
      GET DIAGNOSTICS "outboxEvents" = ROW_COUNT;

      WITH unused AS (
        SELECT v."id"
          FROM "workflow_versions" v
          LEFT JOIN "workflows" w ON w."id" = v."workflowId"
         WHERE (w."id" IS NULL OR v."version" < w."version")
           AND NOT EXISTS (
             SELECT 1 FROM "executions" e
              WHERE e."workflowId" = v."workflowId" AND e."workflowVersion" = v."version" AND e."status" NOT IN ('succeeded', 'failed')
           )
         LIMIT p_batch
           FOR UPDATE OF v SKIP LOCKED
      )
      DELETE FROM "workflow_versions" v USING unused WHERE v."id" = unused."id";
      GET DIAGNOSTICS "workflowVersions" = ROW_COUNT;

      DELETE FROM "execution_watches" WHERE "expiresAt" < now() - interval '1 hour';
      RETURN NEXT;
    END
    $$
`;

const WATCH = `
  CREATE OR REPLACE FUNCTION watch_execution(p_execution_id uuid, p_seconds integer) RETURNS boolean
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    DECLARE
      watched boolean;
    BEGIN
      DELETE FROM "execution_watches" w
       WHERE w."executionId" IN (
         SELECT x."executionId" FROM "execution_watches" x
          WHERE x."expiresAt" < now() - interval '1 hour'
          ORDER BY x."expiresAt"
          LIMIT 20
            FOR UPDATE SKIP LOCKED
       );
      INSERT INTO "execution_watches" ("executionId", "expiresAt")
      SELECT e."id", now() + make_interval(secs => p_seconds)
        FROM "executions" e
       WHERE e."id" = p_execution_id AND e."tenantId" = app_current_tenant()
      ON CONFLICT ("executionId") DO UPDATE SET "expiresAt" = GREATEST("execution_watches"."expiresAt", EXCLUDED."expiresAt")
      RETURNING true INTO watched;
      RETURN watched;
    END
    $$
`;

export class BoundedMaintenance1794322300000 implements MigrationInterface {
  name = 'BoundedMaintenance1794322300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION ${PER_STEP_REAPER_SIGNATURE}`);
    await queryRunner.query(REAPER);
    await queryRunner.query(`REVOKE ALL ON FUNCTION ${REAPER_SIGNATURE} FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION ${REAPER_SIGNATURE} TO flowforge_app`);
    await queryRunner.query(PURGE);
    await queryRunner.query(`CREATE INDEX "IDX_execution_watches_expires" ON "execution_watches" ("expiresAt")`);
    await queryRunner.query(WATCH);
    for (const fn of TRIGGER_FUNCTIONS) await queryRunner.query(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION app_current_tenant() FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION app_current_tenant() TO flowforge_app`);
    await queryRunner.query(`ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`);
    await queryRunner.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM flowforge_app`);
    await queryRunner.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM flowforge_app`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO flowforge_app`);
    await queryRunner.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flowforge_app`);
    await queryRunner.query(`ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION app_current_tenant() TO PUBLIC`);
    for (const fn of TRIGGER_FUNCTIONS) await queryRunner.query(`GRANT EXECUTE ON FUNCTION ${fn} TO PUBLIC`);
    for (const [signature, definition] of [
      [WATCH_SIGNATURE, WATCH_EXECUTION],
      [PURGE_SIGNATURE, RETENTION_PURGE],
      [REAPER_SIGNATURE, PER_STEP_REAPER],
    ]) {
      await queryRunner.query(`DROP FUNCTION ${signature}`);
      await queryRunner.query(definition);
    }
    for (const signature of [WATCH_SIGNATURE, PURGE_SIGNATURE, PER_STEP_REAPER_SIGNATURE]) {
      await queryRunner.query(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`);
      await queryRunner.query(`GRANT EXECUTE ON FUNCTION ${signature} TO flowforge_app`);
    }
    await queryRunner.query(`DROP INDEX "IDX_execution_watches_expires"`);
  }
}

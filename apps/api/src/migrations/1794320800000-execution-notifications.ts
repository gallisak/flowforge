import { MigrationInterface, QueryRunner } from 'typeorm';

export const NOTIFICATION_OUTPUT_MAX_BYTES = 65_536;

const REAPER_RESULT = `("id" uuid, "tenantId" uuid, "executionId" uuid, "status" character varying, "attempts" integer)`;

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
  ),
  failed AS (
    UPDATE "executions" e
       SET "status" = 'failed',
           "error" = 'lease expired ' || reaped."attempts" || ' times: the job was abandoned by its worker on every attempt',
           "finishedAt" = now()
      FROM reaped
     WHERE reaped."status" = 'dead' AND e."id" = reaped."executionId"
  )
  SELECT * FROM reaped
`;

const SYSTEM_FUNCTIONS = [
  'record_execution_event(uuid)',
  'claim_outbox_events(text, integer, integer)',
  'queue_depth_by_tenant(integer)',
  'outbox_backlog()',
];

export class ExecutionNotifications1794320800000 implements MigrationInterface {
  name = 'ExecutionNotifications1794320800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "executions" ADD "correlationId" character varying(128)`);
    await queryRunner.query(
      `ALTER TABLE "webhook_secrets" ADD "purpose" character varying(8) NOT NULL DEFAULT 'inbound'
         CONSTRAINT "CHK_webhook_secrets_purpose" CHECK ("purpose" IN ('inbound', 'outbound'))`,
    );

    await queryRunner.query(`
      CREATE TABLE "notification_endpoints" (
        "tenantId" uuid NOT NULL,
        "url" character varying(2048) NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notification_endpoints_tenant" PRIMARY KEY ("tenantId")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "outbox_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "executionId" uuid NOT NULL,
        "type" character varying(64) NOT NULL,
        "payload" jsonb NOT NULL,
        "correlationId" character varying(128),
        "status" character varying(12) NOT NULL DEFAULT 'pending',
        "attempts" integer NOT NULL DEFAULT 0,
        "nextAttemptAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "lockedBy" character varying,
        "lockedUntil" TIMESTAMP WITH TIME ZONE,
        "lastError" text,
        "lastStatusCode" integer,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deliveredAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_outbox_events_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_outbox_events_status" CHECK ("status" IN ('pending', 'delivering', 'delivered', 'dead'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_outbox_events_due" ON "outbox_events" ("nextAttemptAt") WHERE "status" = 'pending'`);
    await queryRunner.query(
      `CREATE INDEX "IDX_outbox_events_expired_leases" ON "outbox_events" ("lockedUntil") WHERE "status" = 'delivering'`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_outbox_events_execution" ON "outbox_events" ("tenantId", "executionId")`);

    for (const table of ['notification_endpoints', 'outbox_events']) {
      await queryRunner.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      await queryRunner.query(`
        CREATE POLICY "tenant_isolation" ON "${table}"
          USING ("tenantId" = app_current_tenant())
          WITH CHECK ("tenantId" = app_current_tenant())
      `);
    }

    await queryRunner.query(`
      CREATE FUNCTION record_execution_event(p_execution_id uuid) RETURNS void
        LANGUAGE sql VOLATILE SET search_path = public, pg_temp
        AS $$
          INSERT INTO "outbox_events" ("tenantId", "executionId", "type", "payload", "correlationId")
          SELECT e."tenantId", e."id", 'execution.' || e."status",
                 jsonb_build_object(
                   'executionId', e."id",
                   'workflowId', e."workflowId",
                   'workflowVersion', e."workflowVersion",
                   'status', e."status",
                   'trigger', e."trigger",
                   'output', CASE WHEN octet_length(e."output"::text) <= ${NOTIFICATION_OUTPUT_MAX_BYTES} THEN e."output" END,
                   'outputTruncated', COALESCE(octet_length(e."output"::text) > ${NOTIFICATION_OUTPUT_MAX_BYTES}, false),
                   'error', e."error",
                   'finishedAt', e."finishedAt"
                 ),
                 e."correlationId"
            FROM "executions" e
            JOIN "notification_endpoints" n ON n."tenantId" = e."tenantId"
           WHERE e."id" = p_execution_id AND e."status" IN ('succeeded', 'failed')
        $$
    `);

    await queryRunner.query(`
      CREATE FUNCTION claim_outbox_events(p_worker_id text, p_lease_seconds integer, p_limit integer)
        RETURNS SETOF "outbox_events"
        LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
        AS $$
          WITH due AS (
            SELECT o."id" FROM "outbox_events" o
             WHERE o."status" = 'pending' AND o."nextAttemptAt" <= now()
             ORDER BY o."nextAttemptAt"
             LIMIT p_limit
               FOR UPDATE SKIP LOCKED
          ),
          abandoned AS (
            SELECT o."id" FROM "outbox_events" o
             WHERE o."status" = 'delivering' AND o."lockedUntil" < now()
             ORDER BY o."lockedUntil"
             LIMIT p_limit
               FOR UPDATE SKIP LOCKED
          ),
          picked AS (
            SELECT c."id" FROM (SELECT "id" FROM abandoned UNION ALL SELECT "id" FROM due) c LIMIT p_limit
          )
          UPDATE "outbox_events" o
             SET "status" = 'delivering',
                 "lockedBy" = p_worker_id,
                 "lockedUntil" = now() + make_interval(secs => p_lease_seconds),
                 "attempts" = o."attempts" + 1
            FROM picked
           WHERE o."id" = picked."id"
          RETURNING o.*
        $$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION reap_expired_jobs()
        RETURNS TABLE ${REAPER_RESULT}
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
        AS $$
        DECLARE
          reaped_job record;
          dead_executions uuid[] := '{}';
        BEGIN
          FOR reaped_job IN ${EXPIRE_JOBS}
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
    `);

    await queryRunner.query(`
      CREATE FUNCTION queue_depth_by_tenant(p_top integer)
        RETURNS TABLE ("tenant" text, "status" character varying, "jobs" integer)
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
        AS $$
          WITH counts AS (
            SELECT j."tenantId", 'queued'::character varying AS "status", count(*) AS n
              FROM "jobs" j
             WHERE j."status" = 'queued'
             GROUP BY j."tenantId"
            UNION ALL
            SELECT j."tenantId", 'running'::character varying, count(*)
              FROM "jobs" j
             WHERE j."status" = 'running'
             GROUP BY j."tenantId"
          ),
          ranked AS (
            SELECT c."tenantId", row_number() OVER (ORDER BY sum(c.n) DESC, c."tenantId") AS position
              FROM counts c
             GROUP BY c."tenantId"
          )
          SELECT CASE WHEN r.position <= p_top THEN c."tenantId"::text ELSE 'other' END, c."status", sum(c.n)::integer
            FROM counts c
            JOIN ranked r ON r."tenantId" = c."tenantId"
           GROUP BY 1, 2
        $$
    `);
    await queryRunner.query(`
      CREATE FUNCTION outbox_backlog() RETURNS integer
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
        AS $$ SELECT count(*)::integer FROM "outbox_events" WHERE "status" IN ('pending', 'delivering') $$
    `);

    for (const fn of SYSTEM_FUNCTIONS) {
      await queryRunner.query(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC`);
      await queryRunner.query(`GRANT EXECUTE ON FUNCTION ${fn} TO flowforge_app`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION outbox_backlog()`);
    await queryRunner.query(`DROP FUNCTION queue_depth_by_tenant(integer)`);
    await queryRunner.query(`DROP FUNCTION reap_expired_jobs()`);
    await queryRunner.query(`
      CREATE FUNCTION reap_expired_jobs()
        RETURNS TABLE ${REAPER_RESULT}
        LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
        AS $$ ${EXPIRE_JOBS} $$
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION reap_expired_jobs() FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION reap_expired_jobs() TO flowforge_app`);
    await queryRunner.query(`DROP FUNCTION claim_outbox_events(text, integer, integer)`);
    await queryRunner.query(`DROP FUNCTION record_execution_event(uuid)`);
    await queryRunner.query(`DROP TABLE "outbox_events"`);
    await queryRunner.query(`DROP TABLE "notification_endpoints"`);
    await queryRunner.query(`ALTER TABLE "webhook_secrets" DROP COLUMN "purpose"`);
    await queryRunner.query(`ALTER TABLE "executions" DROP COLUMN "correlationId"`);
  }
}

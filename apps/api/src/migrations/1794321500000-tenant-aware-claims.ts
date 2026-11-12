import { MigrationInterface, QueryRunner } from 'typeorm';

export const CLAIM_JOB_SKIPPING_FUTURE_JOBS = `
  CREATE OR REPLACE FUNCTION claim_job(p_worker_id text, p_lease_seconds integer, p_default_max_running integer DEFAULT 10)
    RETURNS SETOF "jobs"
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    DECLARE
      candidate uuid;
      picked uuid;
      max_running integer;
      running integer;
      contended boolean;
    BEGIN
      FOR attempt IN 1..10 LOOP
        contended := false;
        FOR candidate IN
          WITH RECURSIVE ready AS (
            (SELECT j."tenantId" FROM "jobs" j
              WHERE j."status" = 'queued'
              ORDER BY j."tenantId" LIMIT 1)
            UNION ALL
            SELECT (SELECT j."tenantId" FROM "jobs" j
                     WHERE j."status" = 'queued' AND j."tenantId" > r."tenantId"
                     ORDER BY j."tenantId" LIMIT 1)
              FROM ready r
             WHERE r."tenantId" IS NOT NULL
          )
          SELECT r."tenantId"
            FROM ready r
            LEFT JOIN "tenant_queue_state" s ON s."tenantId" = r."tenantId"
           WHERE r."tenantId" IS NOT NULL
             AND (SELECT j."runAt" FROM "jobs" j
                   WHERE j."status" = 'queued' AND j."tenantId" = r."tenantId"
                   ORDER BY j."runAt" LIMIT 1) <= now()
           ORDER BY s."lastClaimedAt" NULLS FIRST, r."tenantId"
        LOOP
          SELECT coalesce(t."maxConcurrentJobs", p_default_max_running) INTO max_running FROM "tenants" t WHERE t."id" = candidate;
          SELECT count(*) INTO running FROM "jobs" j WHERE j."tenantId" = candidate AND j."status" = 'running';
          CONTINUE WHEN running >= max_running;
          INSERT INTO "tenant_queue_state" ("tenantId") VALUES (candidate) ON CONFLICT DO NOTHING;
          PERFORM 1 FROM "tenant_queue_state" s WHERE s."tenantId" = candidate FOR UPDATE SKIP LOCKED;
          IF NOT FOUND THEN
            contended := true;
            CONTINUE;
          END IF;
          SELECT count(*) INTO running FROM "jobs" j WHERE j."tenantId" = candidate AND j."status" = 'running';
          CONTINUE WHEN running >= max_running;
          SELECT j."id" INTO picked
            FROM "jobs" j
           WHERE j."tenantId" = candidate AND j."status" = 'queued' AND j."runAt" <= now()
           ORDER BY j."runAt"
           LIMIT 1
             FOR UPDATE SKIP LOCKED;
          CONTINUE WHEN picked IS NULL;
          UPDATE "tenant_queue_state" SET "lastClaimedAt" = clock_timestamp() WHERE "tenantId" = candidate;
          RETURN QUERY
            UPDATE "jobs" j
               SET "status" = 'running',
                   "lockedBy" = p_worker_id,
                   "lockedUntil" = now() + make_interval(secs => p_lease_seconds),
                   "attempts" = j."attempts" + 1
             WHERE j."id" = picked
            RETURNING j.*;
          RETURN;
        END LOOP;
        EXIT WHEN NOT contended;
        PERFORM pg_sleep(0.005);
      END LOOP;
    END
    $$
`;

const CLAIM_JOB_FILTERING_FUTURE_JOBS = `
  CREATE OR REPLACE FUNCTION claim_job(p_worker_id text, p_lease_seconds integer, p_default_max_running integer DEFAULT 10)
    RETURNS SETOF "jobs"
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    DECLARE
      candidate uuid;
      picked uuid;
      max_running integer;
      running integer;
      contended boolean;
    BEGIN
      FOR attempt IN 1..5 LOOP
        contended := false;
        FOR candidate IN
          WITH RECURSIVE ready AS (
            (SELECT j."tenantId" FROM "jobs" j
              WHERE j."status" = 'queued' AND j."runAt" <= now()
              ORDER BY j."tenantId" LIMIT 1)
            UNION ALL
            SELECT (SELECT j."tenantId" FROM "jobs" j
                     WHERE j."status" = 'queued' AND j."runAt" <= now() AND j."tenantId" > r."tenantId"
                     ORDER BY j."tenantId" LIMIT 1)
              FROM ready r
             WHERE r."tenantId" IS NOT NULL
          )
          SELECT r."tenantId"
            FROM ready r
            LEFT JOIN "tenant_queue_state" s ON s."tenantId" = r."tenantId"
           WHERE r."tenantId" IS NOT NULL
           ORDER BY s."lastClaimedAt" NULLS FIRST, r."tenantId"
        LOOP
          SELECT coalesce(t."maxConcurrentJobs", p_default_max_running) INTO max_running FROM "tenants" t WHERE t."id" = candidate;
          SELECT count(*) INTO running FROM "jobs" j WHERE j."tenantId" = candidate AND j."status" = 'running';
          CONTINUE WHEN running >= max_running;
          INSERT INTO "tenant_queue_state" ("tenantId") VALUES (candidate) ON CONFLICT DO NOTHING;
          PERFORM 1 FROM "tenant_queue_state" s WHERE s."tenantId" = candidate FOR UPDATE SKIP LOCKED;
          IF NOT FOUND THEN
            contended := true;
            CONTINUE;
          END IF;
          SELECT count(*) INTO running FROM "jobs" j WHERE j."tenantId" = candidate AND j."status" = 'running';
          CONTINUE WHEN running >= max_running;
          SELECT j."id" INTO picked
            FROM "jobs" j
           WHERE j."tenantId" = candidate AND j."status" = 'queued' AND j."runAt" <= now()
           ORDER BY j."runAt"
           LIMIT 1
             FOR UPDATE SKIP LOCKED;
          CONTINUE WHEN picked IS NULL;
          UPDATE "tenant_queue_state" SET "lastClaimedAt" = clock_timestamp() WHERE "tenantId" = candidate;
          RETURN QUERY
            UPDATE "jobs" j
               SET "status" = 'running',
                   "lockedBy" = p_worker_id,
                   "lockedUntil" = now() + make_interval(secs => p_lease_seconds),
                   "attempts" = j."attempts" + 1
             WHERE j."id" = picked
            RETURNING j.*;
          RETURN;
        END LOOP;
        EXIT WHEN NOT contended;
        PERFORM pg_sleep(0.002);
      END LOOP;
    END
    $$
`;

const QUEUE_DEPTH_WITH_DELAYED_JOBS = `
      CREATE OR REPLACE FUNCTION queue_depth_by_tenant(p_top integer)
        RETURNS TABLE ("tenant" text, "status" character varying, "jobs" integer)
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
        AS $$
          WITH counts AS (
            SELECT j."tenantId", CASE WHEN j."runAt" <= now() THEN 'queued' ELSE 'delayed' END::character varying AS "status", count(*) AS n
              FROM "jobs" j
             WHERE j."status" = 'queued'
             GROUP BY 1, 2
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
    `;

const QUEUE_DEPTH = `
      CREATE OR REPLACE FUNCTION queue_depth_by_tenant(p_top integer)
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
    `;

const FAIR_OUTBOX_CLAIM = `
      CREATE FUNCTION claim_outbox_events(p_worker_id text, p_lease_seconds integer, p_limit integer, p_per_tenant integer)
        RETURNS SETOF "outbox_events"
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
        AS $$
        DECLARE
          picked uuid[];
          candidate uuid;
          in_flight integer;
        BEGIN
          picked := ARRAY(
            SELECT o."id" FROM "outbox_events" o
             WHERE o."status" = 'delivering' AND o."lockedUntil" < now()
             ORDER BY o."lockedUntil"
             LIMIT p_limit
               FOR UPDATE SKIP LOCKED
          );
          FOR candidate IN
            WITH RECURSIVE waiting AS (
              (SELECT o."tenantId" FROM "outbox_events" o
                WHERE o."status" = 'pending'
                ORDER BY o."tenantId" LIMIT 1)
              UNION ALL
              SELECT (SELECT o."tenantId" FROM "outbox_events" o
                       WHERE o."status" = 'pending' AND o."tenantId" > w."tenantId"
                       ORDER BY o."tenantId" LIMIT 1)
                FROM waiting w
               WHERE w."tenantId" IS NOT NULL
            )
            SELECT w."tenantId"
              FROM waiting w
              CROSS JOIN LATERAL (
                SELECT o."nextAttemptAt" FROM "outbox_events" o
                 WHERE o."status" = 'pending' AND o."tenantId" = w."tenantId"
                 ORDER BY o."nextAttemptAt" LIMIT 1
              ) oldest
             WHERE w."tenantId" IS NOT NULL AND oldest."nextAttemptAt" <= now()
             ORDER BY oldest."nextAttemptAt", w."tenantId"
          LOOP
            EXIT WHEN cardinality(picked) >= p_limit;
            SELECT count(*) INTO in_flight FROM "outbox_events" o
             WHERE o."status" = 'delivering' AND o."tenantId" = candidate AND o."lockedUntil" >= now();
            CONTINUE WHEN in_flight >= p_per_tenant;
            picked := picked || ARRAY(
              SELECT o."id" FROM "outbox_events" o
               WHERE o."status" = 'pending' AND o."tenantId" = candidate AND o."nextAttemptAt" <= now()
               ORDER BY o."nextAttemptAt"
               LIMIT LEAST(p_per_tenant - in_flight, p_limit - cardinality(picked))
                 FOR UPDATE SKIP LOCKED
            );
          END LOOP;
          RETURN QUERY
            UPDATE "outbox_events" o
               SET "status" = 'delivering',
                   "lockedBy" = p_worker_id,
                   "lockedUntil" = now() + make_interval(secs => p_lease_seconds),
                   "attempts" = o."attempts" + 1
             WHERE o."id" = ANY (picked)
            RETURNING o.*;
        END
        $$
    `;

const OUTBOX_CLAIM = `
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
    `;

export class TenantAwareClaims1794321500000 implements MigrationInterface {
  name = 'TenantAwareClaims1794321500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(CLAIM_JOB_SKIPPING_FUTURE_JOBS);
    await queryRunner.query(QUEUE_DEPTH_WITH_DELAYED_JOBS);
    await queryRunner.query(
      `CREATE INDEX "IDX_outbox_events_pending_by_tenant" ON "outbox_events" ("tenantId", "nextAttemptAt") WHERE "status" = 'pending'`,
    );
    await queryRunner.query(`DROP INDEX "IDX_outbox_events_due"`);
    await queryRunner.query(`DROP FUNCTION claim_outbox_events(text, integer, integer)`);
    await queryRunner.query(FAIR_OUTBOX_CLAIM);
    await queryRunner.query(`REVOKE ALL ON FUNCTION claim_outbox_events(text, integer, integer, integer) FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION claim_outbox_events(text, integer, integer, integer) TO flowforge_app`);
    await queryRunner.query(`CREATE INDEX "IDX_workflows_tenant_created" ON "workflows" ("tenantId", "createdAt", "id")`);
    await queryRunner.query(`CREATE INDEX "IDX_outbox_events_tenant_created" ON "outbox_events" ("tenantId", "createdAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_outbox_events_tenant_created"`);
    await queryRunner.query(`DROP INDEX "IDX_workflows_tenant_created"`);
    await queryRunner.query(`DROP FUNCTION claim_outbox_events(text, integer, integer, integer)`);
    await queryRunner.query(OUTBOX_CLAIM);
    await queryRunner.query(`REVOKE ALL ON FUNCTION claim_outbox_events(text, integer, integer) FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION claim_outbox_events(text, integer, integer) TO flowforge_app`);
    await queryRunner.query(`CREATE INDEX "IDX_outbox_events_due" ON "outbox_events" ("nextAttemptAt") WHERE "status" = 'pending'`);
    await queryRunner.query(`DROP INDEX "IDX_outbox_events_pending_by_tenant"`);
    await queryRunner.query(QUEUE_DEPTH);
    await queryRunner.query(CLAIM_JOB_FILTERING_FUTURE_JOBS);
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

const SINGLE_PASS_CLAIM = `
  CREATE OR REPLACE FUNCTION claim_job(p_worker_id text, p_lease_seconds integer, p_default_max_running integer DEFAULT 10)
    RETURNS SETOF "jobs"
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    DECLARE
      candidate uuid;
      picked uuid;
      max_running integer;
      running integer;
    BEGIN
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
        INSERT INTO "tenant_queue_state" ("tenantId") VALUES (candidate) ON CONFLICT DO NOTHING;
        PERFORM 1 FROM "tenant_queue_state" s WHERE s."tenantId" = candidate FOR UPDATE SKIP LOCKED;
        CONTINUE WHEN NOT FOUND;
        SELECT coalesce(t."maxConcurrentJobs", p_default_max_running) INTO max_running FROM "tenants" t WHERE t."id" = candidate;
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
    END
    $$
`;

const CONTENTION_AWARE_CLAIM = `
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

export class ContentionAwareClaim1794320400000 implements MigrationInterface {
  name = 'ContentionAwareClaim1794320400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(CONTENTION_AWARE_CLAIM);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(SINGLE_PASS_CLAIM);
  }
}

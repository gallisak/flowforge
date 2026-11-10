import { MigrationInterface, QueryRunner } from 'typeorm';

const UNLIMITED_CLAIM = `
  CREATE OR REPLACE FUNCTION claim_job(p_worker_id text, p_lease_seconds integer)
    RETURNS SETOF "jobs"
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    DECLARE
      candidate uuid;
      picked uuid;
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

const LIMITED_CLAIM = `
  CREATE FUNCTION claim_job(p_worker_id text, p_lease_seconds integer, p_default_max_running integer DEFAULT 10)
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

export class TenantLimits1794320300000 implements MigrationInterface {
  name = 'TenantLimits1794320300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tenants" ADD "maxConcurrentJobs" integer`);
    await queryRunner.query(`ALTER TABLE "tenants" ADD "maxQueuedJobs" integer`);
    await queryRunner.query(`ALTER TABLE "tenants" ADD "rateLimitPerMinute" integer`);
    await queryRunner.query(`CREATE INDEX "IDX_jobs_running_by_tenant" ON "jobs" ("tenantId") WHERE "status" = 'running'`);

    await queryRunner.query(`DROP FUNCTION claim_job(text, integer)`);
    await queryRunner.query(LIMITED_CLAIM);
    await queryRunner.query(`REVOKE ALL ON FUNCTION claim_job(text, integer, integer) FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION claim_job(text, integer, integer) TO flowforge_app`);

    await queryRunner.query(`
      CREATE TABLE "rate_limit_windows" (
        "tenantId" uuid NOT NULL,
        "windowStart" TIMESTAMP WITH TIME ZONE NOT NULL,
        "hits" integer NOT NULL,
        CONSTRAINT "PK_rate_limit_windows" PRIMARY KEY ("tenantId", "windowStart")
      )
    `);
    await queryRunner.query(`REVOKE ALL ON "rate_limit_windows" FROM flowforge_app`);
    await queryRunner.query(`
      CREATE FUNCTION rate_limit_hit(p_tenant_id uuid, p_default_limit integer)
        RETURNS TABLE ("limit" integer, "hits" integer, "resetAt" timestamptz)
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
        AS $$
        DECLARE
          window_start timestamptz := date_trunc('minute', now());
        BEGIN
          DELETE FROM "rate_limit_windows" w WHERE w."tenantId" = p_tenant_id AND w."windowStart" < window_start;
          RETURN QUERY
            WITH hit AS (
              INSERT INTO "rate_limit_windows" AS w ("tenantId", "windowStart", "hits")
              VALUES (p_tenant_id, window_start, 1)
              ON CONFLICT ("tenantId", "windowStart") DO UPDATE SET "hits" = w."hits" + 1
              RETURNING w."hits"
            )
            SELECT coalesce((SELECT t."rateLimitPerMinute" FROM "tenants" t WHERE t."id" = p_tenant_id), p_default_limit),
                   hit."hits",
                   window_start + interval '1 minute'
              FROM hit;
        END
        $$
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION rate_limit_hit(uuid, integer) FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION rate_limit_hit(uuid, integer) TO flowforge_app`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION rate_limit_hit(uuid, integer)`);
    await queryRunner.query(`DROP TABLE "rate_limit_windows"`);
    await queryRunner.query(`DROP FUNCTION claim_job(text, integer, integer)`);
    await queryRunner.query(UNLIMITED_CLAIM);
    await queryRunner.query(`REVOKE ALL ON FUNCTION claim_job(text, integer) FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION claim_job(text, integer) TO flowforge_app`);
    await queryRunner.query(`DROP INDEX "IDX_jobs_running_by_tenant"`);
    await queryRunner.query(`ALTER TABLE "tenants" DROP COLUMN "rateLimitPerMinute"`);
    await queryRunner.query(`ALTER TABLE "tenants" DROP COLUMN "maxQueuedJobs"`);
    await queryRunner.query(`ALTER TABLE "tenants" DROP COLUMN "maxConcurrentJobs"`);
  }
}

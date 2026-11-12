import { MigrationInterface, QueryRunner } from 'typeorm';
import { CLAIM_JOB_SKIPPING_FUTURE_JOBS } from './1794321500000-tenant-aware-claims';

const SKIP_TENANT = 'FF001';

const WAKE_TENANT = `
  CREATE FUNCTION wake_tenant_queue() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    DECLARE
      idle_until timestamptz;
    BEGIN
      INSERT INTO "tenant_queue_state" ("tenantId") VALUES (NEW."tenantId") ON CONFLICT DO NOTHING;
      SELECT s."idleUntil" INTO idle_until FROM "tenant_queue_state" s WHERE s."tenantId" = NEW."tenantId" FOR KEY SHARE;
      IF idle_until > NEW."runAt" THEN
        UPDATE "tenant_queue_state" SET "idleUntil" = NEW."runAt"
         WHERE "tenantId" = NEW."tenantId" AND "idleUntil" > NEW."runAt";
      END IF;
      RETURN NULL;
    END
    $$
`;

const CLAIM_JOB_FROM_ACTIVE_TENANTS = `
  CREATE OR REPLACE FUNCTION claim_job(p_worker_id text, p_lease_seconds integer, p_default_max_running integer DEFAULT 10)
    RETURNS SETOF "jobs"
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    DECLARE
      candidate uuid;
      picked uuid;
      max_running integer;
      running integer;
      earliest timestamptz;
      contended boolean;
    BEGIN
      FOR attempt IN 1..10 LOOP
        contended := false;
        FOR candidate IN
          SELECT s."tenantId"
            FROM "tenant_queue_state" s
           WHERE s."idleUntil" IS NULL OR s."idleUntil" <= now()
           ORDER BY s."lastClaimedAt" NULLS FIRST, s."tenantId"
        LOOP
          SELECT coalesce(t."maxConcurrentJobs", p_default_max_running) INTO max_running FROM "tenants" t WHERE t."id" = candidate;
          SELECT count(*) INTO running FROM "jobs" j WHERE j."tenantId" = candidate AND j."status" = 'running';
          CONTINUE WHEN running >= max_running;
          picked := NULL;
          BEGIN
            PERFORM 1 FROM "tenant_queue_state" s WHERE s."tenantId" = candidate FOR NO KEY UPDATE SKIP LOCKED;
            IF NOT FOUND THEN
              contended := true;
              CONTINUE;
            END IF;
            SELECT count(*) INTO running FROM "jobs" j WHERE j."tenantId" = candidate AND j."status" = 'running';
            IF running >= max_running THEN
              RAISE EXCEPTION USING ERRCODE = '${SKIP_TENANT}';
            END IF;
            SELECT j."id" INTO picked
              FROM "jobs" j
             WHERE j."tenantId" = candidate AND j."status" = 'queued' AND j."runAt" <= now()
             ORDER BY j."runAt"
             LIMIT 1
               FOR UPDATE SKIP LOCKED;
            IF picked IS NULL THEN
              PERFORM 1 FROM "tenant_queue_state" s WHERE s."tenantId" = candidate FOR UPDATE SKIP LOCKED;
              IF NOT FOUND THEN
                RAISE EXCEPTION USING ERRCODE = '${SKIP_TENANT}';
              END IF;
              SELECT min(j."runAt") INTO earliest FROM "jobs" j WHERE j."tenantId" = candidate AND j."status" = 'queued';
              IF earliest IS NOT NULL AND earliest <= now() THEN
                RAISE EXCEPTION USING ERRCODE = '${SKIP_TENANT}';
              END IF;
              UPDATE "tenant_queue_state" SET "idleUntil" = coalesce(earliest, 'infinity') WHERE "tenantId" = candidate;
              CONTINUE;
            END IF;
          EXCEPTION WHEN SQLSTATE '${SKIP_TENANT}' THEN
            CONTINUE;
          END;
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

export class IdleTenantClaims1794322400000 implements MigrationInterface {
  name = 'IdleTenantClaims1794322400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tenant_queue_state" ADD COLUMN "idleUntil" timestamptz`);
    await queryRunner.query(`CREATE INDEX "IDX_tenant_queue_state_idle" ON "tenant_queue_state" ("idleUntil")`);
    await queryRunner.query(WAKE_TENANT);
    await queryRunner.query(`REVOKE ALL ON FUNCTION wake_tenant_queue() FROM PUBLIC`);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_jobs_wake_tenant_queue"
        AFTER INSERT OR UPDATE OF "status", "runAt" ON "jobs"
        FOR EACH ROW WHEN (NEW."status" = 'queued')
        EXECUTE FUNCTION wake_tenant_queue()
    `);
    await queryRunner.query(`
      INSERT INTO "tenant_queue_state" ("tenantId")
      SELECT DISTINCT j."tenantId" FROM "jobs" j WHERE j."status" = 'queued'
      ON CONFLICT DO NOTHING
    `);
    await queryRunner.query(`
      UPDATE "tenant_queue_state" s
         SET "idleUntil" = coalesce((SELECT min(j."runAt") FROM "jobs" j WHERE j."tenantId" = s."tenantId" AND j."status" = 'queued'), 'infinity')
    `);
    await queryRunner.query(CLAIM_JOB_FROM_ACTIVE_TENANTS);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(CLAIM_JOB_SKIPPING_FUTURE_JOBS);
    await queryRunner.query(`DROP TRIGGER "TRG_jobs_wake_tenant_queue" ON "jobs"`);
    await queryRunner.query(`DROP FUNCTION wake_tenant_queue()`);
    await queryRunner.query(`DROP INDEX "IDX_tenant_queue_state_idle"`);
    await queryRunner.query(`ALTER TABLE "tenant_queue_state" DROP COLUMN "idleUntil"`);
  }
}

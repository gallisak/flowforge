import { MigrationInterface, QueryRunner } from 'typeorm';

const FIFO_CLAIM = `
  CREATE OR REPLACE FUNCTION claim_job(p_worker_id text, p_lease_seconds integer)
    RETURNS SETOF "jobs"
    LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
      WITH next AS (
        SELECT q."id"
          FROM "jobs" q
         WHERE q."status" = 'queued' AND q."runAt" <= now()
         ORDER BY q."runAt"
         LIMIT 1
           FOR UPDATE SKIP LOCKED
      )
      UPDATE "jobs" j
         SET "status" = 'running',
             "lockedBy" = p_worker_id,
             "lockedUntil" = now() + make_interval(secs => p_lease_seconds),
             "attempts" = j."attempts" + 1
        FROM next
       WHERE j."id" = next."id"
      RETURNING j.*
    $$
`;

const ROUND_ROBIN_CLAIM = `
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

export class FairJobClaim1794320200000 implements MigrationInterface {
  name = 'FairJobClaim1794320200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "tenant_queue_state" (
        "tenantId" uuid NOT NULL,
        "lastClaimedAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_tenant_queue_state" PRIMARY KEY ("tenantId")
      )
    `);
    await queryRunner.query(`REVOKE ALL ON "tenant_queue_state" FROM flowforge_app`);
    await queryRunner.query(`CREATE INDEX "IDX_jobs_queued_by_tenant" ON "jobs" ("tenantId", "runAt") WHERE "status" = 'queued'`);
    await queryRunner.query(ROUND_ROBIN_CLAIM);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(FIFO_CLAIM);
    await queryRunner.query(`DROP INDEX "IDX_jobs_queued_by_tenant"`);
    await queryRunner.query(`DROP TABLE "tenant_queue_state"`);
  }
}

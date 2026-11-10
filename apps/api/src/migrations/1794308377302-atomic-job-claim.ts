import { MigrationInterface, QueryRunner } from 'typeorm';

export class AtomicJobClaim1794308377302 implements MigrationInterface {
  name = 'AtomicJobClaim1794308377302';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION claim_job(p_worker_id text, p_lease_seconds integer)
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
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION claim_job(text, integer) FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION claim_job(text, integer) TO flowforge_app`);
    await queryRunner.query(`DROP FUNCTION next_ready_job()`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION next_ready_job()
        RETURNS TABLE ("id" uuid, "tenantId" uuid)
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
        AS $$
          SELECT j."id", j."tenantId"
            FROM "jobs" j
           WHERE j."status" = 'queued' AND j."runAt" <= now()
           ORDER BY j."runAt"
           LIMIT 1
        $$
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION next_ready_job() FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION next_ready_job() TO flowforge_app`);
    await queryRunner.query(`DROP FUNCTION claim_job(text, integer)`);
  }
}

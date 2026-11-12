import { MigrationInterface, QueryRunner } from 'typeorm';

const PURGE_SIGNATURE = 'purge_finished_data(interval, integer)';

export class DataRetention1794321900000 implements MigrationInterface {
  name = 'DataRetention1794321900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_executions_finished" ON "executions" ("finishedAt") WHERE "status" IN ('succeeded', 'failed')`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_executions_unfinished_version" ON "executions" ("workflowId", "workflowVersion") WHERE "status" NOT IN ('succeeded', 'failed')`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_jobs_execution" ON "jobs" ("executionId")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_outbox_events_finished" ON "outbox_events" ("createdAt") WHERE "status" IN ('delivered', 'dead')`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_outbox_events_tenant_status_created" ON "outbox_events" ("tenantId", "status", "createdAt")`);
    await queryRunner.query(`
      CREATE FUNCTION purge_finished_data(p_retention interval, p_batch integer)
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
          DELETE FROM "step_runs" WHERE "executionId" = ANY (purged);
          DELETE FROM "jobs" WHERE "executionId" = ANY (purged);
          DELETE FROM "outbox_events" WHERE "executionId" = ANY (purged);
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
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION ${PURGE_SIGNATURE} FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION ${PURGE_SIGNATURE} TO flowforge_app`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION ${PURGE_SIGNATURE}`);
    for (const index of [
      'IDX_outbox_events_tenant_status_created',
      'IDX_outbox_events_finished',
      'IDX_jobs_execution',
      'IDX_executions_unfinished_version',
      'IDX_executions_finished',
    ]) {
      await queryRunner.query(`DROP INDEX "${index}"`);
    }
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';
import { REAPER } from './1794322300000-bounded-maintenance';
import { FAIR_OUTBOX_CLAIM } from './1794321500000-tenant-aware-claims';

export const STATUS_CHECKS = [
  { table: 'jobs', name: 'CHK_jobs_status', expression: `"status" IN ('queued', 'running', 'done', 'failed', 'dead')` },
  { table: 'executions', name: 'CHK_executions_status', expression: `"status" IN ('pending', 'running', 'waiting', 'succeeded', 'failed')` },
  { table: 'executions', name: 'CHK_executions_trigger', expression: `"trigger" IN ('api', 'webhook', 'cron')` },
  { table: 'step_runs', name: 'CHK_step_runs_status', expression: `"status" IN ('running', 'waiting', 'succeeded', 'failed')` },
] as const;

const DUE_SCHEDULE_COLUMNS = `
  "id" uuid, "tenantId" uuid, "cron" character varying, "timezone" character varying,
  "nextRunAt" timestamptz, "missedRunPolicy" character varying
`;

const claimDueSchedule = (lock: 'FOR UPDATE' | 'FOR NO KEY UPDATE') => `
  CREATE OR REPLACE FUNCTION claim_due_schedule(p_now timestamptz)
    RETURNS TABLE (${DUE_SCHEDULE_COLUMNS})
    LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
      SELECT w."id", w."tenantId", w."cron", w."timezone", w."nextRunAt", w."missedRunPolicy"
        FROM "workflows" w
       WHERE w."nextRunAt" IS NOT NULL
         AND COALESCE(w."scheduleRetryAt", w."nextRunAt") <= p_now
         AND w."enabled" = true
         AND w."cron" IS NOT NULL
       ORDER BY COALESCE(w."scheduleRetryAt", w."nextRunAt")
       LIMIT 1
         ${lock} SKIP LOCKED
    $$
`;

const purgeFinishedData = (guard: string) => `
  CREATE OR REPLACE FUNCTION purge_finished_data(p_retention interval, p_batch integer)
    RETURNS TABLE ("executions" integer, "outboxEvents" integer, "workflowVersions" integer)
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    DECLARE
      purged uuid[];
    BEGIN
      ${guard}
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

const RETENTION_GUARD = `
      IF p_retention IS NULL OR p_retention < interval '1 day' THEN
        RAISE EXCEPTION 'retention must be at least one day';
      END IF;
      IF p_batch IS NULL OR p_batch < 1 OR p_batch > 10000 THEN
        RAISE EXCEPTION 'batch must be between 1 and 10000';
      END IF;`;

const reaperLockingTenantsInOrder = () => {
  const replaced = REAPER.replace('CREATE FUNCTION reap_expired_jobs', 'CREATE OR REPLACE FUNCTION reap_expired_jobs')
    .replace(
      `      dead_executions uuid[] := '{}';
    BEGIN
      FOR reaped_job IN
        WITH expired AS (
          SELECT q."id"
            FROM "jobs" q
           WHERE q."status" = 'running' AND q."lockedUntil" < now()
           ORDER BY q."lockedUntil"
           LIMIT p_batch
             FOR UPDATE SKIP LOCKED
        ),`,
      `      dead_executions uuid[] := '{}';
      expired_ids uuid[];
    BEGIN
      SELECT coalesce(array_agg(q."id"), '{}') INTO expired_ids
        FROM (
          SELECT j."id"
            FROM "jobs" j
           WHERE j."status" = 'running' AND j."lockedUntil" < now()
           ORDER BY j."lockedUntil"
           LIMIT p_batch
             FOR UPDATE SKIP LOCKED
        ) q;
      PERFORM 1
         FROM "tenant_queue_state" s
        WHERE s."tenantId" IN (SELECT j."tenantId" FROM "jobs" j WHERE j."id" = ANY (expired_ids))
        ORDER BY s."tenantId"
          FOR NO KEY UPDATE;
      FOR reaped_job IN
        WITH expired AS (
          SELECT unnest(expired_ids) AS "id"
        ),`,
    );
  if (replaced === REAPER.replace('CREATE FUNCTION reap_expired_jobs', 'CREATE OR REPLACE FUNCTION reap_expired_jobs')) {
    throw new Error('the reaper definition changed; update the review hardening migration');
  }
  return replaced;
};

const ABANDONED_ANY_TENANT = `picked := ARRAY(
            SELECT o."id" FROM "outbox_events" o
             WHERE o."status" = 'delivering' AND o."lockedUntil" < now()
             ORDER BY o."lockedUntil"
             LIMIT p_limit
               FOR UPDATE SKIP LOCKED
          );`;

const ABANDONED_WITHIN_TENANT_LIMIT = `picked := ARRAY(
            SELECT o."id" FROM "outbox_events" o
             WHERE o."id" IN (
                     SELECT r."id"
                       FROM (SELECT x."id", x."lockedUntil",
                                    row_number() OVER (PARTITION BY x."tenantId" ORDER BY x."lockedUntil") AS position
                               FROM "outbox_events" x
                              WHERE x."status" = 'delivering' AND x."lockedUntil" < now()) r
                      WHERE r.position <= p_per_tenant
                      ORDER BY r."lockedUntil"
                      LIMIT p_limit)
               AND o."status" = 'delivering' AND o."lockedUntil" < now()
               FOR UPDATE SKIP LOCKED
          );`;

const LIVE_IN_FLIGHT = `SELECT count(*) INTO in_flight FROM "outbox_events" o
             WHERE o."status" = 'delivering' AND o."tenantId" = candidate AND o."lockedUntil" >= now();`;

const IN_FLIGHT_WITH_PICKED = `SELECT count(*) INTO in_flight FROM "outbox_events" o
             WHERE o."tenantId" = candidate
               AND ((o."status" = 'delivering' AND o."lockedUntil" >= now()) OR o."id" = ANY (picked));`;

const outboxClaim = (abandoned: string, inFlight: string) => {
  const source = FAIR_OUTBOX_CLAIM.replace('CREATE FUNCTION claim_outbox_events', 'CREATE OR REPLACE FUNCTION claim_outbox_events');
  if (!source.includes(ABANDONED_ANY_TENANT) || !source.includes(LIVE_IN_FLIGHT)) {
    throw new Error('the outbox claim definition changed; update the review hardening migration');
  }
  return source.replace(ABANDONED_ANY_TENANT, abandoned).replace(LIVE_IN_FLIGHT, inFlight);
};

export class ReviewHardening1794322700000 implements MigrationInterface {
  name = 'ReviewHardening1794322700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION set_tenant_api_key(p_tenant_id uuid, p_api_key_hash text) RETURNS uuid
        LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
        AS $$
          UPDATE "tenants" SET "apiKeyHash" = p_api_key_hash
           WHERE "id" = p_tenant_id AND p_api_key_hash ~ '^[0-9a-f]{64}$'
          RETURNING "id"
        $$
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION set_tenant_api_key(uuid, text) FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION set_tenant_api_key(uuid, text) TO flowforge_app`);

    await queryRunner.query(purgeFinishedData(RETENTION_GUARD));
    await queryRunner.query(reaperLockingTenantsInOrder());
    await queryRunner.query(outboxClaim(ABANDONED_WITHIN_TENANT_LIMIT, IN_FLIGHT_WITH_PICKED));
    await queryRunner.query(claimDueSchedule('FOR NO KEY UPDATE'));

    for (const { table, name, expression } of STATUS_CHECKS) {
      await queryRunner.query(`ALTER TABLE "${table}" ADD CONSTRAINT "${name}" CHECK (${expression}) NOT VALID`);
      await queryRunner.query(`ALTER TABLE "${table}" VALIDATE CONSTRAINT "${name}"`);
    }

  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const { table, name } of [...STATUS_CHECKS].reverse()) {
      await queryRunner.query(`ALTER TABLE "${table}" DROP CONSTRAINT "${name}"`);
    }
    await queryRunner.query(claimDueSchedule('FOR UPDATE'));
    await queryRunner.query(purgeFinishedData(''));
    await queryRunner.query(outboxClaim(ABANDONED_ANY_TENANT, LIVE_IN_FLIGHT));
    await queryRunner.query(REAPER.replace('CREATE FUNCTION reap_expired_jobs', 'CREATE OR REPLACE FUNCTION reap_expired_jobs'));
    await queryRunner.query(`DROP FUNCTION set_tenant_api_key(uuid, text)`);
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';
import { EXECUTION_EVENTS_CHANNEL } from './1794320900000-execution-change-notifications';

const WATCH_SIGNATURE = 'watch_execution(uuid, integer)';

function notifyFunction(onlyWatched: boolean): string {
  return `
    CREATE OR REPLACE FUNCTION notify_execution_change() RETURNS trigger
      LANGUAGE plpgsql ${onlyWatched ? 'SECURITY DEFINER' : ''} SET search_path = public, pg_temp
      AS $$
      DECLARE
        changed uuid;
      BEGIN
        IF TG_TABLE_NAME = 'executions' THEN
          changed := NEW."id";
        ELSE
          changed := NEW."executionId";
        END IF;
        ${
          onlyWatched
            ? `IF EXISTS (SELECT 1 FROM "execution_watches" w WHERE w."executionId" = changed AND w."expiresAt" > now()) THEN
          PERFORM pg_notify('${EXECUTION_EVENTS_CHANNEL}', changed::text);
        END IF;`
            : `PERFORM pg_notify('${EXECUTION_EVENTS_CHANNEL}', changed::text);`
        }
        RETURN NULL;
      END
      $$
  `;
}

export class WatchedExecutionNotifications1794321850000 implements MigrationInterface {
  name = 'WatchedExecutionNotifications1794321850000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "execution_watches" (
        "executionId" uuid PRIMARY KEY,
        "expiresAt" timestamptz NOT NULL
      )
    `);
    await queryRunner.query(`REVOKE ALL ON TABLE "execution_watches" FROM flowforge_app`);
    await queryRunner.query(`
      CREATE FUNCTION watch_execution(p_execution_id uuid, p_seconds integer) RETURNS boolean
        LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
        AS $$
          INSERT INTO "execution_watches" ("executionId", "expiresAt")
          SELECT e."id", now() + make_interval(secs => p_seconds)
            FROM "executions" e
           WHERE e."id" = p_execution_id AND e."tenantId" = app_current_tenant()
          ON CONFLICT ("executionId") DO UPDATE SET "expiresAt" = GREATEST("execution_watches"."expiresAt", EXCLUDED."expiresAt")
          RETURNING true
        $$
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION ${WATCH_SIGNATURE} FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION ${WATCH_SIGNATURE} TO flowforge_app`);
    await queryRunner.query(notifyFunction(true));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(notifyFunction(false));
    await queryRunner.query(`DROP FUNCTION ${WATCH_SIGNATURE}`);
    await queryRunner.query(`DROP TABLE "execution_watches"`);
  }
}

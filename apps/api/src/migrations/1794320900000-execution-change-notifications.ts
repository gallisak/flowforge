import { MigrationInterface, QueryRunner } from 'typeorm';

export const EXECUTION_EVENTS_CHANNEL = 'execution_events';

export class ExecutionChangeNotifications1794320900000 implements MigrationInterface {
  name = 'ExecutionChangeNotifications1794320900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION notify_execution_change() RETURNS trigger
        LANGUAGE plpgsql SET search_path = public, pg_temp
        AS $$
        BEGIN
          IF TG_TABLE_NAME = 'executions' THEN
            PERFORM pg_notify('${EXECUTION_EVENTS_CHANNEL}', NEW."id"::text);
          ELSE
            PERFORM pg_notify('${EXECUTION_EVENTS_CHANNEL}', NEW."executionId"::text);
          END IF;
          RETURN NULL;
        END
        $$
    `);
    for (const table of ['executions', 'step_runs']) {
      await queryRunner.query(`
        CREATE TRIGGER "TRG_${table}_notify_change"
          AFTER INSERT OR UPDATE ON "${table}"
          FOR EACH ROW EXECUTE FUNCTION notify_execution_change()
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['executions', 'step_runs']) {
      await queryRunner.query(`DROP TRIGGER "TRG_${table}_notify_change" ON "${table}"`);
    }
    await queryRunner.query(`DROP FUNCTION notify_execution_change()`);
  }
}

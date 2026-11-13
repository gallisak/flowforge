import { MigrationInterface, QueryRunner } from 'typeorm';

const LOCAL_TIMESTAMPS: ReadonlyArray<[table: string, column: string]> = [
  ['tenants', 'createdAt'],
  ['workflows', 'createdAt'],
  ['executions', 'createdAt'],
  ['jobs', 'createdAt'],
  ['step_runs', 'startedAt'],
];

export class TimeZoneAwareTimestamps1794322500000 implements MigrationInterface {
  name = 'TimeZoneAwareTimestamps1794322500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL TimeZone = 'UTC'`);
    for (const [table, column] of LOCAL_TIMESTAMPS) {
      await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE timestamptz`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL TimeZone = 'UTC'`);
    for (const [table, column] of LOCAL_TIMESTAMPS) {
      await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE timestamp`);
    }
  }
}

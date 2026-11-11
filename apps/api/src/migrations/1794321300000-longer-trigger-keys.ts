import { MigrationInterface, QueryRunner } from 'typeorm';

export class LongerTriggerKeys1794321300000 implements MigrationInterface {
  name = 'LongerTriggerKeys1794321300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "executions" ALTER COLUMN "triggerKey" TYPE character varying(320)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "executions" ALTER COLUMN "triggerKey" TYPE character varying(300)`);
  }
}

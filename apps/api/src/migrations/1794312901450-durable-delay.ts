import { MigrationInterface, QueryRunner } from 'typeorm';

export class DurableDelay1794312901450 implements MigrationInterface {
  name = 'DurableDelay1794312901450';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "step_runs" ADD "wakeAt" TIMESTAMP WITH TIME ZONE`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "step_runs" DROP COLUMN "wakeAt"`);
  }
}

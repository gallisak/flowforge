import { MigrationInterface, QueryRunner } from 'typeorm';

export class StepIdempotencyKeys1794313078517 implements MigrationInterface {
  name = 'StepIdempotencyKeys1794313078517';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "step_runs" ADD "idempotencyKey" character varying`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "step_runs" DROP COLUMN "idempotencyKey"`);
  }
}

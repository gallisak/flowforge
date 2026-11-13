import { MigrationInterface, QueryRunner } from 'typeorm';

export class WorkflowRevisions1794322600000 implements MigrationInterface {
  name = 'WorkflowRevisions1794322600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "workflows" ADD COLUMN "revision" integer`);
    await queryRunner.query(`UPDATE "workflows" SET "revision" = "version"`);
    await queryRunner.query(`ALTER TABLE "workflows" ALTER COLUMN "revision" SET DEFAULT 1`);
    await queryRunner.query(`ALTER TABLE "workflows" ALTER COLUMN "revision" SET NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "workflows" DROP COLUMN "revision"`);
  }
}

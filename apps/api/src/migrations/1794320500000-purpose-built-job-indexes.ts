import { MigrationInterface, QueryRunner } from 'typeorm';

export class PurposeBuiltJobIndexes1794320500000 implements MigrationInterface {
  name = 'PurposeBuiltJobIndexes1794320500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX "IDX_jobs_expired_leases" ON "jobs" ("lockedUntil") WHERE "status" = 'running'`);
    await queryRunner.query(`DROP INDEX "IDX_f0517eec3f63f617ee5138edeb"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX "IDX_f0517eec3f63f617ee5138edeb" ON "jobs" ("status", "runAt")`);
    await queryRunner.query(`DROP INDEX "IDX_jobs_expired_leases"`);
  }
}

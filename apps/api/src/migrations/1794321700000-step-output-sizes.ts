import { MigrationInterface, QueryRunner } from 'typeorm';

const TABLES = ['executions', 'step_runs'] as const;

export class StepOutputSizes1794321700000 implements MigrationInterface {
  name = 'StepOutputSizes1794321700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION measure_output() RETURNS trigger
        LANGUAGE plpgsql SET search_path = public, pg_temp
        AS $$
        BEGIN
          NEW."outputBytes" := CASE WHEN NEW."output" IS NULL THEN NULL ELSE octet_length(NEW."output"::text) END;
          RETURN NEW;
        END
        $$
    `);
    for (const table of TABLES) {
      await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "outputBytes" integer`);
      await queryRunner.query(`ALTER TABLE "${table}" DISABLE TRIGGER "TRG_${table}_notify_change"`);
      await queryRunner.query(`UPDATE "${table}" SET "outputBytes" = octet_length("output"::text) WHERE "output" IS NOT NULL`);
      await queryRunner.query(`ALTER TABLE "${table}" ENABLE TRIGGER "TRG_${table}_notify_change"`);
      await queryRunner.query(`
        CREATE TRIGGER "TRG_${table}_measure_output"
          BEFORE INSERT OR UPDATE OF "output" ON "${table}"
          FOR EACH ROW EXECUTE FUNCTION measure_output()
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of TABLES) {
      await queryRunner.query(`DROP TRIGGER "TRG_${table}_measure_output" ON "${table}"`);
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "outputBytes"`);
    }
    await queryRunner.query(`DROP FUNCTION measure_output()`);
  }
}

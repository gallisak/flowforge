import { MigrationInterface, QueryRunner } from 'typeorm';

export class NotificationListIndexes1794322100000 implements MigrationInterface {
  name = 'NotificationListIndexes1794322100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_outbox_events_tenant_created"`);
    await queryRunner.query(`DROP INDEX "IDX_outbox_events_tenant_status_created"`);
    await queryRunner.query(`CREATE INDEX "IDX_outbox_events_tenant_created" ON "outbox_events" ("tenantId", "createdAt", "id")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_outbox_events_tenant_status_created" ON "outbox_events" ("tenantId", "status", "createdAt", "id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_outbox_events_tenant_status_created"`);
    await queryRunner.query(`DROP INDEX "IDX_outbox_events_tenant_created"`);
    await queryRunner.query(`CREATE INDEX "IDX_outbox_events_tenant_created" ON "outbox_events" ("tenantId", "createdAt")`);
    await queryRunner.query(`CREATE INDEX "IDX_outbox_events_tenant_status_created" ON "outbox_events" ("tenantId", "status", "createdAt")`);
  }
}

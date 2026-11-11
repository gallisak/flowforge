import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('notification_endpoints')
export class NotificationEndpoint {
  @PrimaryColumn('uuid')
  tenantId: string;

  @Column({ type: 'varchar', length: 2048 })
  url: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export const OUTBOX_EVENT_STATUSES = ['pending', 'delivering', 'delivered', 'dead'] as const;
export type OutboxEventStatus = (typeof OUTBOX_EVENT_STATUSES)[number];

@Entity('outbox_events')
@Check('CHK_outbox_events_status', `"status" IN ('pending', 'delivering', 'delivered', 'dead')`)
@Index('IDX_outbox_events_pending_by_tenant', ['tenantId', 'nextAttemptAt'], { where: `"status" = 'pending'` })
@Index('IDX_outbox_events_expired_leases', ['lockedUntil'], { where: `"status" = 'delivering'` })
@Index('IDX_outbox_events_execution', ['tenantId', 'executionId'])
@Index('IDX_outbox_events_tenant_created', ['tenantId', 'createdAt'])
@Index('IDX_outbox_events_tenant_status_created', ['tenantId', 'status', 'createdAt'])
@Index('IDX_outbox_events_finished', ['createdAt'], { where: `"status" IN ('delivered', 'dead')` })
export class OutboxEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  tenantId: string;

  @Column('uuid')
  executionId: string;

  @Column({ type: 'varchar', length: 64 })
  type: string;

  @Column('jsonb')
  payload: Record<string, unknown>;

  @Column({ type: 'varchar', length: 128, nullable: true })
  correlationId: string | null;

  @Column({ type: 'varchar', length: 12, default: 'pending' })
  status: OutboxEventStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  nextAttemptAt: Date;

  @Column({ type: 'varchar', nullable: true })
  lockedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  lockedUntil: Date | null;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @Column({ type: 'int', nullable: true })
  lastStatusCode: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;
}

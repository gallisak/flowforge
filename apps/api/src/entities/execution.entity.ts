import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

export const EXECUTION_STATUSES = ['pending', 'running', 'waiting', 'succeeded', 'failed'] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

@Entity('executions')
@Unique('UQ_executions_tenant_id', ['tenantId', 'id'])
@Index('IDX_executions_tenant_created', ['tenantId', 'createdAt', 'id'])
@Index('IDX_executions_tenant_status_created', ['tenantId', 'status', 'createdAt', 'id'])
@Index('IDX_executions_tenant_workflow_created', ['tenantId', 'workflowId', 'createdAt', 'id'])
@Index('IDX_executions_finished', ['finishedAt'], { where: `"status" IN ('succeeded', 'failed')` })
@Index('IDX_executions_unfinished_version', ['workflowId', 'workflowVersion'], { where: `"status" NOT IN ('succeeded', 'failed')` })
@Index('UQ_executions_tenant_trigger_key', ['tenantId', 'triggerKey'], { unique: true, where: '"triggerKey" IS NOT NULL' })
export class Execution {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  tenantId: string;

  @Column('uuid')
  workflowId: string;

  @Column({ type: 'int', default: 1 })
  workflowVersion: number;

  @Column({ type: 'varchar', default: 'pending' })
  status: ExecutionStatus;

  @Column({ type: 'jsonb', default: {} })
  input: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  output: unknown;

  @Column({ type: 'int', nullable: true, select: false, insert: false, update: false })
  outputBytes?: number | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ type: 'varchar', default: 'api' })
  trigger: 'api' | 'webhook' | 'cron';

  @Column({ type: 'varchar', length: 320, nullable: true })
  triggerKey: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  correlationId: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}

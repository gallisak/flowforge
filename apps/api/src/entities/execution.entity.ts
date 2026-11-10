import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type ExecutionStatus = 'pending' | 'running' | 'succeeded' | 'failed';

@Entity('executions')
@Index(['tenantId', 'createdAt'])
export class Execution {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  tenantId: string;

  @Column('uuid')
  workflowId: string;

  @Column({ type: 'varchar', default: 'pending' })
  status: ExecutionStatus;

  @Column({ type: 'jsonb', default: {} })
  input: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  output: unknown;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ type: 'varchar', default: 'api' })
  trigger: 'api' | 'webhook' | 'cron';

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}

import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Execution } from './execution.entity';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'dead';

@Entity('jobs')
@Index('IDX_jobs_expired_leases', ['lockedUntil'], { where: `"status" = 'running'` })
@Index('IDX_jobs_running_by_tenant', ['tenantId'], { where: `"status" = 'running'` })
@Index('IDX_jobs_execution', ['executionId'])
@Index('IDX_jobs_queued_by_tenant', ['tenantId', 'runAt'], { where: `"status" = 'queued'` })
export class Job {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  tenantId: string;

  @Column('uuid')
  executionId: string;

  @ManyToOne(() => Execution, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'tenantId', referencedColumnName: 'tenantId', foreignKeyConstraintName: 'FK_jobs_execution' },
    { name: 'executionId', referencedColumnName: 'id', foreignKeyConstraintName: 'FK_jobs_execution' },
  ])
  execution?: Execution;

  @Column({ type: 'varchar', default: 'queued' })
  status: JobStatus;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  runAt: Date;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'int', default: 8 })
  maxAttempts: number;

  @Column({ type: 'int', default: 0 })
  attemptsAtProgress: number;

  @Column({ type: 'varchar', nullable: true })
  lockedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  lockedUntil: Date | null;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

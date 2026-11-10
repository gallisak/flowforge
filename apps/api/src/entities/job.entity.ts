import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'dead';

@Entity('jobs')
@Index(['status', 'runAt'])
@Index('IDX_jobs_queued_by_tenant', ['tenantId', 'runAt'], { where: `"status" = 'queued'` })
export class Job {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  tenantId: string;

  @Column('uuid')
  executionId: string;

  @Column({ type: 'varchar', default: 'queued' })
  status: JobStatus;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  runAt: Date;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'int', default: 3 })
  maxAttempts: number;

  @Column({ type: 'varchar', nullable: true })
  lockedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  lockedUntil: Date | null;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @CreateDateColumn()
  createdAt: Date;
}

import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Execution } from './execution.entity';

export type StepRunStatus = 'running' | 'waiting' | 'succeeded' | 'failed';

@Entity('step_runs')
@Index('UQ_step_runs_execution_step', ['executionId', 'stepIndex'], { unique: true })
export class StepRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  tenantId: string;

  @Column('uuid')
  executionId: string;

  @ManyToOne(() => Execution, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'tenantId', referencedColumnName: 'tenantId', foreignKeyConstraintName: 'FK_step_runs_execution' },
    { name: 'executionId', referencedColumnName: 'id', foreignKeyConstraintName: 'FK_step_runs_execution' },
  ])
  execution?: Execution;

  @Column('int')
  stepIndex: number;

  @Column()
  stepId: string;

  @Column({ type: 'varchar', default: 'running' })
  status: StepRunStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'varchar', nullable: true })
  idempotencyKey: string | null;

  @Column({ type: 'jsonb', nullable: true })
  output: unknown;

  @Column({ type: 'int', nullable: true, select: false, insert: false, update: false })
  outputBytes?: number | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn()
  startedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  wakeAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}

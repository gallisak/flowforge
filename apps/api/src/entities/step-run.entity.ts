import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type StepRunStatus = 'running' | 'succeeded' | 'failed';

@Entity('step_runs')
@Index('UQ_step_runs_execution_step', ['executionId', 'stepIndex'], { unique: true })
export class StepRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  tenantId: string;

  @Column('uuid')
  executionId: string;

  @Column('int')
  stepIndex: number;

  @Column()
  stepId: string;

  @Column({ type: 'varchar', default: 'running' })
  status: StepRunStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'jsonb', nullable: true })
  output: unknown;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn()
  startedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}

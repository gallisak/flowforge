import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('step_runs')
@Index(['executionId', 'stepIndex'])
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
  status: 'running' | 'succeeded' | 'failed';

  @Column({ type: 'jsonb', nullable: true })
  output: unknown;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn()
  startedAt: Date;
}

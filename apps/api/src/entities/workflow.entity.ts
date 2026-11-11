import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { MissedRunPolicy } from '../scheduler/cron-schedule';

export type StepDefinition =
  | { id: string; type: 'http'; url: string; method?: string; headers?: Record<string, string>; body?: string }
  | { id: string; type: 'transform'; expr: string }
  | { id: string; type: 'log'; message: string }
  | { id: string; type: 'delay'; ms: number };

@Entity('workflows')
@Check('CHK_workflows_missed_run_policy', `"missedRunPolicy" IN ('skip', 'once', 'all')`)
@Index(['tenantId'])
@Index('IDX_workflows_next_run_at', ['nextRunAt'], { where: '"nextRunAt" IS NOT NULL' })
export class Workflow {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  tenantId: string;

  @Column()
  name: string;

  @Column('jsonb')
  steps: StepDefinition[];

  @Column({ default: true })
  enabled: boolean;

  @Column({ type: 'varchar', nullable: true })
  cron: string | null;

  @Column({ default: 'UTC' })
  timezone: string;

  @Column({ type: 'varchar', length: 8, default: 'once' })
  missedRunPolicy: MissedRunPolicy;

  @Column({ type: 'timestamptz', nullable: true })
  nextRunAt: Date | null;

  @Column({ default: 1 })
  version: number;

  @CreateDateColumn()
  createdAt: Date;
}

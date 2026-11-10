import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type StepDefinition =
  | { id: string; type: 'http'; url: string; method?: string; headers?: Record<string, string>; body?: string }
  | { id: string; type: 'transform'; expr: string }
  | { id: string; type: 'log'; message: string }
  | { id: string; type: 'delay'; ms: number };

@Entity('workflows')
@Index(['tenantId'])
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

  @Column({ default: 1 })
  version: number;

  @CreateDateColumn()
  createdAt: Date;
}

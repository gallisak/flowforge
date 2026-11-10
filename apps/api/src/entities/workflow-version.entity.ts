import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { StepDefinition } from './workflow.entity';

@Entity('workflow_versions')
@Index('UQ_workflow_versions_workflow_version', ['workflowId', 'version'], { unique: true })
export class WorkflowVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  tenantId: string;

  @Column('uuid')
  workflowId: string;

  @Column('int')
  version: number;

  @Column('jsonb')
  steps: StepDefinition[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

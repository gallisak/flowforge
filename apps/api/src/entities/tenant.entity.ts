import { Check, Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { TENANT_LIMITS_CHECK } from '../migrations/1794322000000-tenant-limit-checks';

@Entity('tenants')
@Check('CHK_tenants_limits', TENANT_LIMITS_CHECK)
export class Tenant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ unique: true })
  apiKeyHash: string;

  @Column({ type: 'int', nullable: true })
  maxConcurrentJobs: number | null;

  @Column({ type: 'int', nullable: true })
  maxQueuedJobs: number | null;

  @Column({ type: 'int', nullable: true })
  rateLimitPerMinute: number | null;

  @CreateDateColumn()
  createdAt: Date;
}

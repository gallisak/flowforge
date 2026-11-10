import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('tenants')
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

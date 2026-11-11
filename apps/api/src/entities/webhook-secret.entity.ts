import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type SecretPurpose = 'inbound' | 'outbound';

@Entity('webhook_secrets')
@Check('CHK_webhook_secrets_purpose', `"purpose" IN ('inbound', 'outbound')`)
@Index('IDX_webhook_secrets_tenant', ['tenantId'])
export class WebhookSecret {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  tenantId: string;

  @Column()
  secret: string;

  @Column({ type: 'varchar', length: 8, default: 'inbound' })
  purpose: SecretPurpose;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;
}

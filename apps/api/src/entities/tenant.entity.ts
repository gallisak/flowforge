import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('tenants')
export class Tenant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  /** sha256(apiKey) у hex. Сам ключ показується лише при створенні. */
  @Column({ unique: true })
  apiKeyHash: string;

  /** Секрет для підпису вхідних webhook-ів цього тенанта. */
  @Column()
  webhookSecret: string;

  @CreateDateColumn()
  createdAt: Date;
}

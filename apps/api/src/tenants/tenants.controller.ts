import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { randomBytes, randomUUID } from 'crypto';
import { IsString, Length } from 'class-validator';
import { hashApiKey } from '../auth/api-key.guard';
import { TenantDb } from '../db/tenant-db.service';
import { Tenant } from '../entities';
import { WebhookSecretsService } from '../webhooks/webhook-secrets.service';
import { AdminTokenGuard } from './admin-token.guard';

class CreateTenantDto {
  @IsString()
  @Length(2, 200)
  name: string;
}

@Controller('tenants')
@UseGuards(AdminTokenGuard)
export class TenantsController {
  constructor(
    private readonly db: TenantDb,
    private readonly secrets: WebhookSecretsService,
  ) {}

  @Post()
  async create(@Body() dto: CreateTenantDto) {
    const apiKey = `ff_${randomBytes(24).toString('hex')}`;
    const id = randomUUID();
    const { tenant, secret } = await this.db.run(id, async (em) => ({
      tenant: await em.save(em.create(Tenant, { id, name: dto.name, apiKeyHash: hashApiKey(apiKey) })),
      secret: await this.secrets.create(em, id),
    }));
    return { id: tenant.id, name: tenant.name, apiKey, webhookSecret: secret.secret };
  }
}

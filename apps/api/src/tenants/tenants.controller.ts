import { Body, Controller, NotFoundException, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { randomBytes, randomUUID } from 'crypto';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
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

export class UpdateTenantLimitsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  maxConcurrentJobs?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  maxQueuedJobs?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  rateLimitPerMinute?: number | null;
}

const LIMIT_FIELDS = ['maxConcurrentJobs', 'maxQueuedJobs', 'rateLimitPerMinute'] as const;

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

  @Patch(':id/limits')
  async updateLimits(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTenantLimitsDto) {
    const changes = Object.fromEntries(LIMIT_FIELDS.filter((field) => dto[field] !== undefined).map((field) => [field, dto[field]]));
    const tenant = await this.db.run(id, async (em) => {
      if (Object.keys(changes).length > 0) await em.update(Tenant, { id }, changes);
      return em.findOne(Tenant, { where: { id } });
    });
    if (!tenant) throw new NotFoundException('Tenant not found');
    return {
      id: tenant.id,
      maxConcurrentJobs: tenant.maxConcurrentJobs,
      maxQueuedJobs: tenant.maxQueuedJobs,
      rateLimitPerMinute: tenant.rateLimitPerMinute,
    };
  }
}

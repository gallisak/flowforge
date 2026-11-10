import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { randomBytes, randomUUID } from 'crypto';
import { IsString, Length } from 'class-validator';
import { hashApiKey } from '../auth/api-key.guard';
import { TenantDb } from '../db/tenant-db.service';
import { Tenant } from '../entities';
import { AdminTokenGuard } from './admin-token.guard';

class CreateTenantDto {
  @IsString()
  @Length(2, 200)
  name: string;
}

@Controller('tenants')
@UseGuards(AdminTokenGuard)
export class TenantsController {
  constructor(private readonly db: TenantDb) {}

  @Post()
  async create(@Body() dto: CreateTenantDto) {
    const apiKey = `ff_${randomBytes(24).toString('hex')}`;
    const webhookSecret = randomBytes(24).toString('hex');
    const id = randomUUID();
    const tenant = await this.db.run(id, (em) =>
      em.save(em.create(Tenant, { id, name: dto.name, apiKeyHash: hashApiKey(apiKey), webhookSecret })),
    );
    return { id: tenant.id, name: tenant.name, apiKey, webhookSecret };
  }
}

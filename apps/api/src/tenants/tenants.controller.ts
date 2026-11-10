import { Body, Controller, ForbiddenException, Headers, Inject, Post } from '@nestjs/common';
import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { IsString, MinLength } from 'class-validator';
import { hashApiKey } from '../auth/api-key.guard';
import { API_CONFIG, ApiConfig } from '../config/config';
import { TenantDb } from '../db/tenant-db.service';
import { Tenant } from '../entities';

class CreateTenantDto {
  @IsString()
  @MinLength(2)
  name: string;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

@Controller('tenants')
export class TenantsController {
  constructor(
    private readonly db: TenantDb,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Post()
  async create(@Body() dto: CreateTenantDto, @Headers('x-admin-token') admin?: string) {
    const expected = this.config.adminToken;
    if (!expected || !admin || !safeEqual(admin, expected)) {
      throw new ForbiddenException();
    }
    const apiKey = `ff_${randomBytes(24).toString('hex')}`;
    const webhookSecret = randomBytes(24).toString('hex');
    const id = randomUUID();
    const tenant = await this.db.run(id, (em) =>
      em.save(em.create(Tenant, { id, name: dto.name, apiKeyHash: hashApiKey(apiKey), webhookSecret })),
    );
    return { id: tenant.id, name: tenant.name, apiKey, webhookSecret };
  }
}

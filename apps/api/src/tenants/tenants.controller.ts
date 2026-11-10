import { Body, Controller, ForbiddenException, Headers, Post } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes, timingSafeEqual } from 'crypto';
import { IsString, MinLength } from 'class-validator';
import { Repository } from 'typeorm';
import { hashApiKey } from '../auth/api-key.guard';
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
  constructor(@InjectRepository(Tenant) private readonly tenants: Repository<Tenant>) {}

  /** Службовий ендпоінт створення тенанта (захищений ADMIN_TOKEN). */
  @Post()
  async create(@Body() dto: CreateTenantDto, @Headers('x-admin-token') admin?: string) {
    const expected = process.env.ADMIN_TOKEN ?? '';
    if (!expected || !admin || !safeEqual(admin, expected)) {
      throw new ForbiddenException();
    }
    const apiKey = `ff_${randomBytes(24).toString('hex')}`;
    const webhookSecret = randomBytes(24).toString('hex');
    const tenant = await this.tenants.save(
      this.tenants.create({ name: dto.name, apiKeyHash: hashApiKey(apiKey), webhookSecret }),
    );
    return { id: tenant.id, name: tenant.name, apiKey, webhookSecret };
  }
}

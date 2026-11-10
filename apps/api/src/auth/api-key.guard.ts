import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { Repository } from 'typeorm';
import { Tenant } from '../entities';

export interface TenantRequest {
  headers: Record<string, string | string[] | undefined>;
  tenant: Tenant;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(@InjectRepository(Tenant) private readonly tenants: Repository<Tenant>) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<TenantRequest>();
    const key = req.headers['x-api-key'];
    if (typeof key !== 'string' || key.length === 0) {
      throw new UnauthorizedException('Відсутній x-api-key');
    }
    const tenant = await this.tenants.findOne({ where: { apiKeyHash: hashApiKey(key) } });
    if (!tenant) {
      throw new UnauthorizedException('Невірний API-ключ');
    }
    req.tenant = tenant;
    return true;
  }
}

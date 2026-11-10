import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { Response } from 'express';
import { AuthenticatedTenant, TenantDb } from '../db/tenant-db.service';
import { RateLimitService } from '../limits/rate-limit.service';

export interface TenantRequest {
  headers: Record<string, string | string[] | undefined>;
  tenant: AuthenticatedTenant;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly db: TenantDb,
    private readonly rateLimit: RateLimitService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<TenantRequest>();
    const key = req.headers['x-api-key'];
    if (typeof key !== 'string' || key.length === 0) {
      throw new UnauthorizedException('Missing x-api-key');
    }
    const tenant = await this.db.authenticate(hashApiKey(key));
    if (!tenant) {
      throw new UnauthorizedException('Invalid API key');
    }
    req.tenant = tenant;
    await this.rateLimit.consume(tenant.id, ctx.switchToHttp().getResponse<Response>());
    return true;
  }
}

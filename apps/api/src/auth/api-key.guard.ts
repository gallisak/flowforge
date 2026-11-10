import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { AuthenticatedTenant, TenantDb } from '../db/tenant-db.service';

export interface TenantRequest {
  headers: Record<string, string | string[] | undefined>;
  tenant: AuthenticatedTenant;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly db: TenantDb) {}

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
    return true;
  }
}

import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { Response } from 'express';
import { AuthenticatedTenant, TenantDb } from '../db/tenant-db.service';
import { AuthFailureLimiter, ClientRequest } from '../limits/auth-failure-limiter';
import { RateLimitService } from '../limits/rate-limit.service';

export interface TenantRequest extends ClientRequest {
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
    private readonly failures: AuthFailureLimiter,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<TenantRequest>();
    const key = req.headers['x-api-key'];
    const address = this.failures.clientAddressOf(req);
    const keyHash = typeof key === 'string' && key.length > 0 ? hashApiKey(key) : undefined;
    this.failures.assertAllowed(address, keyHash);
    if (keyHash === undefined) {
      this.failures.recordFailure(address);
      throw new UnauthorizedException('Missing x-api-key');
    }
    const tenant = await this.db.authenticate(keyHash);
    if (!tenant) {
      this.failures.recordFailure(address);
      throw new UnauthorizedException('Invalid API key');
    }
    this.failures.recordSuccess(keyHash);
    req.tenant = tenant;
    await this.rateLimit.consume(tenant.id, ctx.switchToHttp().getResponse<Response>());
    return true;
  }
}

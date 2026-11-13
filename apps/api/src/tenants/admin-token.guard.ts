import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { safeEqual } from '../common/safe-equal';
import { API_CONFIG, ApiConfig } from '../config/config';
import { AuthFailureLimiter, ClientRequest } from '../limits/auth-failure-limiter';

@Injectable()
export class AdminTokenGuard implements CanActivate {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly failures: AuthFailureLimiter,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<ClientRequest>();
    const bucket = `admin ${this.failures.clientAddressOf(req)}`;
    this.failures.assertAllowed(bucket);
    const token = req.headers['x-admin-token'];
    if (typeof token !== 'string' || !safeEqual(token, this.config.adminToken)) {
      this.failures.recordFailure(bucket);
      throw new ForbiddenException('Missing or invalid x-admin-token');
    }
    return true;
  }
}

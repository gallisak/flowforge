import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { API_CONFIG, ApiConfig } from '../config/config';

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

@Injectable()
export class AdminTokenGuard implements CanActivate {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const token = ctx.switchToHttp().getRequest<{ headers: Record<string, unknown> }>().headers['x-admin-token'];
    if (typeof token !== 'string' || !safeEqual(token, this.config.adminToken)) {
      throw new ForbiddenException();
    }
    return true;
  }
}

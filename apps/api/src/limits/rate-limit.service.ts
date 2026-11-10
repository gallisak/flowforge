import { Inject, Injectable } from '@nestjs/common';
import { Response } from 'express';
import { API_CONFIG, ApiConfig } from '../config/config';
import { TenantDb } from '../db/tenant-db.service';
import { TooManyRequestsException } from './too-many-requests';

@Injectable()
export class RateLimitService {
  constructor(
    private readonly db: TenantDb,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  async consume(tenantId: string, res: Response): Promise<void> {
    const { limit, hits, resetAt } = await this.db.hitRateLimit(tenantId, this.config.tenantRateLimitPerMinute);
    const resetSeconds = Math.ceil(resetAt.getTime() / 1000);
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - hits)));
    res.setHeader('X-RateLimit-Reset', String(resetSeconds));
    if (hits > limit) {
      throw new TooManyRequestsException('Rate limit exceeded', resetSeconds - Date.now() / 1000);
    }
  }
}

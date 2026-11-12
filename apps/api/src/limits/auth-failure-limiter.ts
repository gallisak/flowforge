import { Inject, Injectable } from '@nestjs/common';
import { isIP } from 'net';
import { safeEqual } from '../common/safe-equal';
import { API_CONFIG, ApiConfig } from '../config/config';
import { TooManyRequestsException } from './too-many-requests';

const MAX_TRACKED_ADDRESSES = 10_000;
const MAX_TRUSTED_KEYS = 10_000;
const TRUSTED_KEY_MS = 5 * 60 * 1000;
const WINDOW_MS = 60_000;

export const CLIENT_ADDRESS_HEADER = 'x-client-address';
export const CLIENT_ADDRESS_SECRET_HEADER = 'x-client-address-secret';

export interface ClientRequest {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

function remember<V>(map: Map<string, V>, key: string, value: V, limit: number): void {
  map.delete(key);
  if (map.size >= limit) map.delete(map.keys().next().value as string);
  map.set(key, value);
}

@Injectable()
export class AuthFailureLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly trustedKeys = new Map<string, number>();
  private readonly capacity: number;
  private readonly clientAddressSecret: string;

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    this.capacity = config.authFailuresPerMinute;
    this.clientAddressSecret = config.clientAddressSecret;
  }

  clientAddressOf(req: ClientRequest): string {
    const forwarded = req.headers[CLIENT_ADDRESS_HEADER];
    const secret = req.headers[CLIENT_ADDRESS_SECRET_HEADER];
    const trusted =
      this.clientAddressSecret.length > 0 &&
      typeof forwarded === 'string' &&
      typeof secret === 'string' &&
      isIP(forwarded) !== 0 &&
      safeEqual(secret, this.clientAddressSecret);
    if (trusted) return forwarded;
    return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  }

  private tokensOf(address: string, now: number): number {
    const bucket = this.buckets.get(address);
    if (!bucket) return this.capacity;
    return Math.min(this.capacity, bucket.tokens + ((now - bucket.updatedAt) * this.capacity) / WINDOW_MS);
  }

  assertAllowed(address: string, keyHash?: string): void {
    const now = Date.now();
    if (keyHash !== undefined && (this.trustedKeys.get(keyHash) ?? 0) > now) return;
    const tokens = this.tokensOf(address, now);
    if (tokens >= 1) return;
    const retryAfterSeconds = Math.ceil(((1 - tokens) * WINDOW_MS) / this.capacity / 1000);
    throw new TooManyRequestsException('Too many failed authentication attempts', retryAfterSeconds);
  }

  recordFailure(address: string): void {
    const now = Date.now();
    remember(this.buckets, address, { tokens: Math.max(0, this.tokensOf(address, now) - 1), updatedAt: now }, MAX_TRACKED_ADDRESSES);
  }

  recordSuccess(keyHash: string): void {
    remember(this.trustedKeys, keyHash, Date.now() + TRUSTED_KEY_MS, MAX_TRUSTED_KEYS);
  }
}

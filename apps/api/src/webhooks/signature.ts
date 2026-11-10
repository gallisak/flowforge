import { createHmac, timingSafeEqual } from 'crypto';

const HEX_SHA256 = /^[0-9a-f]{64}$/i;

export function webhookSignature(secret: string, payload: Buffer): Buffer {
  return createHmac('sha256', secret).update(payload).digest();
}

export function signatureMatches(expected: Buffer, provided: string | undefined): boolean {
  if (!provided || !HEX_SHA256.test(provided)) return false;
  return timingSafeEqual(expected, Buffer.from(provided, 'hex'));
}

import { createHmac, timingSafeEqual } from 'crypto';

export interface WebhookHeaders {
  id?: string;
  timestamp?: string;
  signature?: string;
}

const MESSAGE_ID = /^[\x21-\x7e]{1,256}$/;
const TIMESTAMP = /^\d{1,12}$/;
const SHA256_BYTES = 32;

export function webhookSignature(secret: string, id: string, timestamp: string, payload: Buffer): Buffer {
  return createHmac('sha256', secret).update(`${id}.${timestamp}.`).update(payload).digest();
}

function decodeSignature(entry: string): Buffer | undefined {
  const [version, value] = entry.split(',', 2);
  if (version !== 'v1' || !value) return undefined;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === SHA256_BYTES ? decoded : undefined;
}

export function verifyWebhook(
  secrets: readonly string[],
  headers: WebhookHeaders,
  payload: Buffer,
  nowSeconds: number,
  toleranceSeconds: number,
): string | undefined {
  const { id, timestamp, signature } = headers;
  if (!id || !MESSAGE_ID.test(id) || !timestamp || !TIMESTAMP.test(timestamp) || !signature) return undefined;
  if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) return undefined;
  const provided = signature
    .split(' ')
    .map(decodeSignature)
    .filter((candidate): candidate is Buffer => candidate !== undefined);
  let matched = false;
  for (const secret of secrets) {
    const expected = webhookSignature(secret, id, timestamp, payload);
    for (const candidate of provided) matched = timingSafeEqual(expected, candidate) || matched;
  }
  return matched ? id : undefined;
}

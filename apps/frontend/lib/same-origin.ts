import type { NextRequest } from 'next/server';

function configuredOrigin(): string | undefined {
  return process.env.APP_ORIGIN?.replace(/\/$/, '') || undefined;
}

export function servedOverHttps(req: NextRequest): boolean {
  const configured = configuredOrigin();
  if (configured) return configured.startsWith('https:');
  const forwarded = req.headers.get('x-forwarded-proto')?.split(',')[0].trim();
  return (forwarded ?? req.nextUrl.protocol.replace(':', '')) === 'https';
}

export function isSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  const configured = configuredOrigin();
  if (configured) return origin === configured;
  const host = req.headers.get('x-forwarded-host')?.split(',')[0].trim() || req.headers.get('host');
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

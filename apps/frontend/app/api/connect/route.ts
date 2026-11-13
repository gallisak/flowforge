import { NextRequest, NextResponse } from 'next/server';
import { API_KEY_COOKIE, API_TIMEOUT_MS, API_URL, unreachable } from '@/lib/api';
import { clientAddressHeaders } from '@/lib/client-address';
import { MAX_CONNECT_BODY_BYTES, readLimitedText } from '@/lib/request-body';
import { isSameOrigin, servedOverHttps } from '@/lib/same-origin';
import { problemBody } from '@/lib/problem';

export const dynamic = 'force-dynamic';

const MAX_KEY_LENGTH = 200;
const PRINTABLE_ASCII = /^[\x21-\x7E]+$/;
const COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;

function problem(status: number, message: string, headers: Record<string, string> = {}) {
  return NextResponse.json(problemBody(status, message), { status, headers });
}

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return problem(403, 'Cross-site requests are not allowed');
  let apiKey: unknown;
  try {
    ({ apiKey } = JSON.parse(await readLimitedText(req, MAX_CONNECT_BODY_BYTES)) as { apiKey?: unknown });
  } catch {
    return problem(400, 'Request body must be a small JSON object');
  }
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) return problem(400, 'API key is required');
  if (apiKey.length > MAX_KEY_LENGTH) return problem(400, 'API key is too long');
  if (!PRINTABLE_ASCII.test(apiKey.trim())) return problem(400, 'API key contains characters that are not allowed');

  let check: Response;
  try {
    check = await fetch(`${API_URL}/workflows`, {
      headers: { 'x-api-key': apiKey.trim(), ...clientAddressHeaders(req.headers) },
      cache: 'no-store',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (error) {
    const failure = unreachable(error);
    return problem(failure.status, failure.message);
  }
  if (check.status === 401) return problem(400, 'This API key is not valid');
  if (check.status === 429) {
    const retryAfter = check.headers.get('retry-after');
    return problem(429, 'Too many failed attempts. Try again later.', retryAfter ? { 'retry-after': retryAfter } : {});
  }
  if (!check.ok) return problem(502, `The API answered ${check.status}`);

  const res = NextResponse.json({ ok: true });
  res.cookies.set(API_KEY_COOKIE, apiKey.trim(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: servedOverHttps(req),
    path: '/',
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
  return res;
}

export async function DELETE(req: NextRequest) {
  if (!isSameOrigin(req)) return problem(403, 'Cross-site requests are not allowed');
  const res = new NextResponse(null, { status: 204 });
  res.cookies.delete(API_KEY_COOKIE);
  return res;
}

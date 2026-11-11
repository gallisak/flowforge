import { NextRequest, NextResponse } from 'next/server';
import { API_KEY_COOKIE, API_TIMEOUT_MS, API_URL, unreachable } from '@/lib/api';
import { MAX_CONNECT_BODY_BYTES, readLimitedText } from '@/lib/request-body';
import { isSameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const MAX_KEY_LENGTH = 200;
const COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function servedOverHttps(req: NextRequest): boolean {
  return (req.headers.get('x-forwarded-proto') ?? req.nextUrl.protocol.replace(':', '')) === 'https';
}

function problem(status: number, message: string) {
  return NextResponse.json({ statusCode: status, message }, { status });
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

  let check: Response;
  try {
    check = await fetch(`${API_URL}/workflows`, {
      headers: { 'x-api-key': apiKey.trim() },
      cache: 'no-store',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (error) {
    const failure = unreachable(error);
    return problem(failure.status, failure.message);
  }
  if (check.status === 401) return problem(400, 'This API key is not valid');
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

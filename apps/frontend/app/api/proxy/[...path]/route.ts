import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { API_KEY_COOKIE, API_TIMEOUT_MS, API_URL, unreachable } from '@/lib/api';
import { BodyTooLargeError, MAX_PROXY_BODY_BYTES, readLimitedText } from '@/lib/request-body';
import { isSameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const FORWARDED_RESPONSE_HEADERS = ['content-type', 'x-next-cursor', 'x-request-id', 'retry-after'];
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

function problem(status: number, message: string) {
  return NextResponse.json({ statusCode: status, message }, { status, headers: { 'cache-control': 'private, no-store', vary: 'Cookie' } });
}

async function forward(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  if (!path.every((segment) => SAFE_SEGMENT.test(segment))) return problem(400, 'Invalid path');
  if (req.method !== 'GET' && !isSameOrigin(req)) return problem(403, 'Cross-site requests are not allowed');
  const key = req.cookies.get(API_KEY_COOKIE)?.value;
  if (!key) return problem(401, 'Connect with a valid API key first');

  let body: string | undefined;
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    try {
      body = await readLimitedText(req, MAX_PROXY_BODY_BYTES);
    } catch (error) {
      if (error instanceof BodyTooLargeError) return problem(413, error.message);
      throw error;
    }
  }

  let upstream: Response;
  let payload: ArrayBuffer | null;
  try {
    upstream = await fetch(`${API_URL}/${path.join('/')}${req.nextUrl.search}`, {
      method: req.method,
      headers: {
        'x-api-key': key,
        'x-request-id': randomUUID(),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    payload = upstream.status === 204 ? null : await upstream.arrayBuffer();
  } catch (error) {
    const failure = unreachable(error);
    return problem(failure.status, failure.message);
  }

  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('cache-control', 'private, no-store');
  headers.set('vary', 'Cookie');
  return new NextResponse(payload, { status: upstream.status, headers });
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;

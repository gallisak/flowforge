import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { API_KEY_COOKIE, API_TIMEOUT_MS, API_URL, unreachable } from '@/lib/api';
import { clientAddressHeaders } from '@/lib/client-address';
import { BodyTooLargeError, MAX_PROXY_BODY_BYTES, MAX_PROXY_RESPONSE_BYTES, readLimitedText } from '@/lib/request-body';
import { isSameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const FORWARDED_RESPONSE_HEADERS = ['content-type', 'x-next-cursor', 'x-request-id', 'retry-after', 'etag'];
const FORWARDED_REQUEST_HEADERS = ['if-match'];
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;
const RESPONSE_TOO_LARGE = 'The API answer is too large to pass on';

function limitedBody(body: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let passed = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        passed += value.byteLength;
        if (passed > maxBytes) {
          await reader.cancel().catch(() => undefined);
          controller.error(new Error(RESPONSE_TOO_LARGE));
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function declaredLength(res: Response): number | undefined {
  const raw = res.headers.get('content-length');
  return raw !== null && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

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

  const forwardedRequestHeaders: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value) forwardedRequestHeaders[name] = value;
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${API_URL}/${path.join('/')}${req.nextUrl.search}`, {
      method: req.method,
      headers: {
        'x-api-key': key,
        'x-request-id': randomUUID(),
        ...clientAddressHeaders(req.headers),
        ...forwardedRequestHeaders,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (error) {
    const failure = unreachable(error);
    return problem(failure.status, failure.message);
  }

  if ((declaredLength(upstream) ?? 0) > MAX_PROXY_RESPONSE_BYTES) {
    await upstream.body?.cancel().catch(() => undefined);
    return problem(502, RESPONSE_TOO_LARGE);
  }

  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('cache-control', 'private, no-store');
  headers.set('vary', 'Cookie');
  const payload = upstream.status === 204 || !upstream.body ? null : limitedBody(upstream.body, MAX_PROXY_RESPONSE_BYTES);
  const res = new NextResponse(payload, { status: upstream.status, headers });
  if (upstream.status === 401) res.cookies.delete(API_KEY_COOKIE);
  return res;
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;

import { NextRequest, NextResponse } from 'next/server';
import { API_KEY_COOKIE, API_TIMEOUT_MS, API_URL, unreachable } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function problem(status: number, message: string) {
  return NextResponse.json({ statusCode: status, message }, { status });
}

function timeoutError(): Error {
  const error = new Error('The API did not answer in time');
  error.name = 'TimeoutError';
  return error;
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  if (!UUID.test(params.id)) return problem(404, 'Execution not found');
  const key = req.cookies.get(API_KEY_COOKIE)?.value;
  if (!key) return problem(401, 'Connect with an API key first');

  const upstreamAbort = new AbortController();
  const abortUpstream = () => upstreamAbort.abort(req.signal.reason);
  if (req.signal.aborted) abortUpstream();
  else req.signal.addEventListener('abort', abortUpstream, { once: true });
  const headersTimer = setTimeout(() => upstreamAbort.abort(timeoutError()), API_TIMEOUT_MS);

  let upstream: Response;
  try {
    upstream = await fetch(`${API_URL}/executions/${params.id}/events`, {
      headers: { 'x-api-key': key, accept: 'text/event-stream' },
      signal: upstreamAbort.signal,
      cache: 'no-store',
    });
  } catch (error) {
    const failure = unreachable(upstreamAbort.signal.reason ?? error);
    return problem(failure.status, failure.message);
  } finally {
    clearTimeout(headersTimer);
  }

  if (!upstream.ok || !upstream.body) {
    return new NextResponse(await upstream.text().catch(() => ''), {
      status: upstream.status,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(upstream.body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}

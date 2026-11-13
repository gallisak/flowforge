import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/executions/[id]/events/route';
import { API_TIMEOUT_MS } from '@/lib/api';

const ID = '48c61687-afc1-474c-85ae-678f21b706d2';
const context = { params: Promise.resolve({ id: ID }) };

function make(init: { key?: string | null; signal?: AbortSignal } = {}) {
  const headers = new Headers();
  if (init.key !== null) headers.set('cookie', `ff_api_key=${init.key ?? 'ff_key'}`);
  const req = new NextRequest(new URL(`/api/executions/${ID}/events`, 'http://localhost:3001'), { headers });
  if (init.signal) Object.defineProperty(req, 'signal', { value: init.signal });
  return req;
}

describe('execution events route', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('event: snapshot\ndata: {}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('streams the API events with the stored key', async () => {
    const res = await GET(make(), context);

    expect(fetchMock.mock.calls[0][1].headers['x-api-key']).toBe('ff_key');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toContain('event: snapshot');
  });

  it('answers 502 instead of throwing when the API cannot be reached', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    const res = await GET(make(), context);

    expect(res.status).toBe(502);
    expect((await res.json()).message).toBe('The API is not reachable');
  });

  it('passes an API refusal on with its status', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"statusCode":404,"message":"Execution not found"}', { status: 404 }));

    const res = await GET(make(), context);

    expect(res.status).toBe(404);
  });

  it('passes the wait the API asks for when it refuses another stream', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{"statusCode":429,"message":"Too many open execution streams"}', {
        status: 429,
        headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': '10' },
      }),
    );

    const res = await GET(make(), context);

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('10');
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });

  it('answers 504 when the API sends no headers before the deadline', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
    );

    const pending = GET(make(), context);
    await vi.advanceTimersByTimeAsync(API_TIMEOUT_MS);
    const res = await pending;

    expect(res.status).toBe(504);
  });

  it('keeps an open stream alive after the header deadline and closes it with the client', async () => {
    vi.useFakeTimers();
    const client = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce(async (_url: string, init: { signal: AbortSignal }) => {
      upstreamSignal = init.signal;
      return new Response(new ReadableStream(), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });

    const res = await GET(make({ signal: client.signal }), context);
    await vi.advanceTimersByTimeAsync(API_TIMEOUT_MS * 2);
    expect(res.status).toBe(200);
    expect(upstreamSignal?.aborted).toBe(false);

    client.abort();
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it('answers 401 without calling the API when no key is stored', async () => {
    const res = await GET(make({ key: null }), context);

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

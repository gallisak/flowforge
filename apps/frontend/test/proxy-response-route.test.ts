import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, PATCH } from '@/app/api/proxy/[...path]/route';
import { MAX_PROXY_RESPONSE_BYTES } from '@/lib/request-body';

const ORIGIN = 'http://localhost:3001';
const context = (...path: string[]) => ({ params: Promise.resolve({ path }) });
const MIB = 1024 * 1024;

function make(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const headers = new Headers({ host: 'localhost:3001', cookie: 'ff_api_key=ff_key', ...init.headers });
  return new NextRequest(new URL(url, ORIGIN), { method: init.method ?? 'GET', headers, body: init.body });
}

function chunks(count: number, size: number, opts: { endless?: boolean } = {}) {
  const chunk = new Uint8Array(size).fill(97);
  let sent = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === count) {
        if (!opts.endless) controller.close();
        return new Promise(() => undefined);
      }
      sent++;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, wasCancelled: () => cancelled, sentChunks: () => sent };
}

async function readAll(body: ReadableStream<Uint8Array> | null): Promise<number> {
  if (!body) return 0;
  const reader = body.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return total;
    total += value.byteLength;
  }
}

describe('API proxy answers', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('passes the answer on while it is still arriving instead of buffering it whole', async () => {
    const upstream = chunks(1, 1024, { endless: true });
    fetchMock.mockResolvedValueOnce(new Response(upstream.stream, { status: 200, headers: { 'content-type': 'application/json' } }));

    const res = await Promise.race([
      GET(make('/api/proxy/executions/x/output'), context('executions', 'x', 'output')),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000)),
    ]);

    expect(res).not.toBeNull();
    const reader = res!.body!.getReader();
    const first = await reader.read();
    expect(first.value?.byteLength).toBe(1024);
    await reader.cancel();
  });

  it('passes on an answer up to the limit', async () => {
    const upstream = chunks(4, MIB);
    fetchMock.mockResolvedValueOnce(new Response(upstream.stream, { status: 200, headers: { 'content-type': 'application/json' } }));

    const res = await GET(make('/api/proxy/executions/x/output'), context('executions', 'x', 'output'));

    expect(res.status).toBe(200);
    expect(await readAll(res.body)).toBe(4 * MIB);
  });

  it('refuses an answer that declares more bytes than the limit before reading it', async () => {
    const upstream = chunks(1, 16);
    fetchMock.mockResolvedValueOnce(
      new Response(upstream.stream, { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(MAX_PROXY_RESPONSE_BYTES + 1) } }),
    );

    const res = await GET(make('/api/proxy/executions/x/output'), context('executions', 'x', 'output'));

    expect(res.status).toBe(502);
    expect((await res.json()).message).toMatch(/too large/i);
    expect(upstream.sentChunks()).toBeLessThanOrEqual(1);
  });

  it('stops an answer that grows past the limit while it streams and stops reading from the API', async () => {
    const upstream = chunks(MAX_PROXY_RESPONSE_BYTES / MIB + 8, MIB);
    fetchMock.mockResolvedValueOnce(new Response(upstream.stream, { status: 200, headers: { 'content-type': 'application/json' } }));

    const res = await GET(make('/api/proxy/executions/x/output'), context('executions', 'x', 'output'));

    await expect(readAll(res.body)).rejects.toThrow();
    expect(upstream.wasCancelled()).toBe(true);
    expect(upstream.sentChunks()).toBeLessThan(MAX_PROXY_RESPONSE_BYTES / MIB + 8);
  });

  it('forgets the stored key when the API no longer accepts it', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"statusCode":401,"message":"Invalid API key"}', { status: 401, headers: { 'content-type': 'application/json' } }));

    const res = await GET(make('/api/proxy/workflows'), context('workflows'));

    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toMatch(/ff_api_key=;/);
  });

  it('keeps the stored key when the API answers with another error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"statusCode":404}', { status: 404, headers: { 'content-type': 'application/json' } }));

    const res = await GET(make('/api/proxy/workflows/x'), context('workflows', 'x'));

    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('passes the version of a workflow back and the expected version of an edit on', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"version":3}', { status: 200, headers: { 'content-type': 'application/json', etag: '"3"' } }));
    const read = await GET(make('/api/proxy/workflows/w1'), context('workflows', 'w1'));
    expect(read.headers.get('etag')).toBe('"3"');

    fetchMock.mockResolvedValueOnce(new Response('{"statusCode":412}', { status: 412, headers: { 'content-type': 'application/json' } }));
    const edit = await PATCH(
      make('/api/proxy/workflows/w1', { method: 'PATCH', headers: { origin: ORIGIN, 'if-match': '"3"', 'content-type': 'application/json' }, body: '{"name":"x"}' }),
      context('workflows', 'w1'),
    );

    expect(fetchMock.mock.calls[1][1].headers['if-match']).toBe('"3"');
    expect(edit.status).toBe(412);
  });
});

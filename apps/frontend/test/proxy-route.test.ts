import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DELETE, GET, POST } from '@/app/api/proxy/[...path]/route';
import { MAX_PROXY_BODY_BYTES } from '@/lib/request-body';

const ORIGIN = 'http://localhost:3001';
const context = (...path: string[]) => ({ params: Promise.resolve({ path }) });

function make(url: string, init: { method?: string; key?: string | null; origin?: string | null; body?: string } = {}) {
  const headers = new Headers({ host: 'localhost:3001' });
  if (init.key !== null) headers.set('cookie', `ff_api_key=${init.key ?? 'ff_key'}`);
  if (init.origin !== null && init.origin !== undefined) headers.set('origin', init.origin);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  return new NextRequest(new URL(url, ORIGIN), { method: init.method ?? 'GET', headers, body: init.body });
}

describe('API proxy route', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json', 'x-next-cursor': 'c2', 'set-cookie': 'x=1' } }));
    vi.stubGlobal('fetch', fetchMock);
  });

  it('forwards the query string and the API key and passes the pagination header back', async () => {
    const res = await GET(make('/api/proxy/executions?status=failed&cursor=c1'), context('executions'));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3000/executions?status=failed&cursor=c1');
    expect(init.headers['x-api-key']).toBe('ff_key');
    expect(init.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get('x-next-cursor')).toBe('c2');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('forwards the method and the body of a same-origin write', async () => {
    await POST(make('/api/proxy/workflows', { method: 'POST', origin: ORIGIN, body: '{"name":"x"}' }), context('workflows'));

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"name":"x"}');
    expect(init.headers['content-type']).toBe('application/json');
  });

  it.each([
    ['from another site', 'https://evil.example'],
    ['without an origin', null],
  ])('refuses a write %s', async (_case, origin) => {
    const res = await DELETE(make('/api/proxy/workflows/1', { method: 'DELETE', origin }), context('workflows', '1'));

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 401 without calling the API when no key is stored', async () => {
    const res = await GET(make('/api/proxy/workflows', { key: null }), context('workflows'));

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses path segments that could leave the intended route', async () => {
    const res = await GET(make('/api/proxy/x'), context('workflows', '..', 'tenants'));

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 502 when the API cannot be reached', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    const res = await GET(make('/api/proxy/workflows'), context('workflows'));

    expect(res.status).toBe(502);
  });

  it('gives every call to the API a deadline and answers 504 when it passes', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

    const res = await GET(make('/api/proxy/workflows'), context('workflows'));

    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(res.status).toBe(504);
  });

  it('refuses a body larger than the limit without calling the API', async () => {
    const body = JSON.stringify({ name: 'x'.repeat(MAX_PROXY_BODY_BYTES) });

    const res = await POST(make('/api/proxy/workflows', { method: 'POST', origin: ORIGIN, body }), context('workflows'));

    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DELETE, POST } from '@/app/api/connect/route';
import { MAX_CONNECT_BODY_BYTES } from '@/lib/request-body';

const ORIGIN = 'http://localhost:3001';

function make(method: string, body?: unknown, origin: string | null = ORIGIN) {
  const headers = new Headers({ 'content-type': 'application/json', host: 'localhost:3001' });
  if (origin) headers.set('origin', origin);
  return new NextRequest(new URL('/api/connect', ORIGIN), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

describe('connect route', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  it('checks the key with the API before storing it in an http-only cookie', async () => {
    const res = await POST(make('POST', { apiKey: ' ff_valid ' }));

    expect(fetchMock.mock.calls[0][1].headers['x-api-key']).toBe('ff_valid');
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('ff_api_key=ff_valid');
    expect(cookie.toLowerCase()).toContain('httponly');
    expect(cookie.toLowerCase()).toContain('samesite=lax');
    expect(cookie.toLowerCase()).not.toContain('secure');
  });

  it('marks the cookie secure when the site is served over https', async () => {
    const req = make('POST', { apiKey: 'ff_valid' });
    req.headers.set('x-forwarded-proto', 'https');

    const res = await POST(req);

    expect((res.headers.get('set-cookie') ?? '').toLowerCase()).toContain('secure');
  });

  it('refuses a key that the API rejects and stores nothing', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }));

    const res = await POST(make('POST', { apiKey: 'ff_wrong' }));

    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe('This API key is not valid');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it.each([
    ['an empty key', { apiKey: '  ' }, 'API key is required'],
    ['a key that is too long', { apiKey: 'x'.repeat(201) }, 'API key is too long'],
  ])('refuses %s without calling the API', async (_case, body, message) => {
    const res = await POST(make('POST', body));

    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe(message);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a line break', 'ff_key\nX-Injected: 1'],
    ['a character outside Latin-1', 'ff_key☃'],
    ['a space inside', 'ff key'],
  ])('refuses a key with %s without calling the API', async (_case, apiKey) => {
    const res = await POST(make('POST', { apiKey }));

    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe('API key contains characters that are not allowed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an oversized body without calling the API', async () => {
    const res = await POST(make('POST', { apiKey: 'ff_valid', padding: 'x'.repeat(MAX_CONNECT_BODY_BYTES) }));

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 504 and stores nothing when the API does not answer in time', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

    const res = await POST(make('POST', { apiKey: 'ff_valid' }));

    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(res.status).toBe(504);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('refuses a request from another site', async () => {
    const res = await POST(make('POST', { apiKey: 'ff_valid' }, 'https://evil.example'));

    expect(res.status).toBe(403);
  });

  it('clears the cookie on disconnect', async () => {
    const res = await DELETE(make('DELETE'));

    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toMatch(/ff_api_key=;/);
  });
});

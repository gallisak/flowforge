import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as connect } from '@/app/api/connect/route';
import { GET as proxyGet } from '@/app/api/proxy/[...path]/route';
import { DisconnectButton } from '@/components/disconnect-button';
import { isSameOrigin } from '@/lib/same-origin';
import { serverConfigProblems } from '@/lib/server-config';

const router = { push: vi.fn(), refresh: vi.fn(), replace: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/' }));

const request = (url: string, headers: Record<string, string>, init: { method?: string; body?: string } = {}) =>
  new NextRequest(new URL(url, 'http://localhost:3001'), { method: init.method ?? 'GET', headers: new Headers(headers), body: init.body });

describe('frontend hardening', () => {
  beforeEach(() => {
    router.push.mockReset();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('keeps proxied answers out of shared caches, since the cookie decides the tenant', async () => {
    const res = await proxyGet(request('/api/proxy/workflows', { cookie: 'ff_api_key=ff_key' }), { params: Promise.resolve({ path: ['workflows'] }) });

    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('vary')).toMatch(/cookie/i);
  });

  it('requires API_URL in production instead of calling itself', () => {
    expect(serverConfigProblems({ NODE_ENV: 'production' })).toEqual(['API_URL is required in production']);
    expect(serverConfigProblems({ NODE_ENV: 'production', API_URL: 'http://api:3000' })).toEqual([]);
    expect(serverConfigProblems({ NODE_ENV: 'development' })).toEqual([]);
  });

  it('takes the first host of a forwarded host list', () => {
    expect(isSameOrigin(request('/x', { origin: 'https://flowforge.example', 'x-forwarded-host': 'flowforge.example, proxy.internal' }))).toBe(true);
  });

  it('compares the origin with APP_ORIGIN when it is configured, whatever the host header says', () => {
    vi.stubEnv('APP_ORIGIN', 'https://flowforge.example');

    expect(isSameOrigin(request('/x', { origin: 'https://flowforge.example', host: 'internal:3001' }))).toBe(true);
    expect(isSameOrigin(request('/x', { origin: 'https://evil.example', host: 'evil.example' }))).toBe(false);
  });

  it('stores the key for a short time and secure when APP_ORIGIN is https', async () => {
    vi.stubEnv('APP_ORIGIN', 'https://flowforge.example');

    const res = await connect(
      request('/api/connect', { origin: 'https://flowforge.example', 'content-type': 'application/json' }, { method: 'POST', body: '{"apiKey":"ff_valid"}' }),
    );

    const cookie = (res.headers.get('set-cookie') ?? '').toLowerCase();
    expect(cookie).toContain('secure');
    expect(Number(/max-age=(\d+)/.exec(cookie)?.[1])).toBeLessThanOrEqual(12 * 60 * 60);
  });

  it.each([
    ['the server refuses', () => Promise.resolve(new Response('{"message":"Cross-site requests are not allowed"}', { status: 403 }))],
    ['the network fails', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('does not pretend to disconnect when %s', async (_case, answer) => {
    vi.stubGlobal('fetch', vi.fn(answer));
    render(<DisconnectButton />);

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not disconnect/i);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled());
    expect(router.push).not.toHaveBeenCalled();
  });
});

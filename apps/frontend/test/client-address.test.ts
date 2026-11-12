import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cookieValue = vi.hoisted(() => ({ current: undefined as string | undefined }));
const forwardedFor = vi.hoisted(() => ({ current: '203.0.113.5' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => (cookieValue.current === undefined ? undefined : { value: cookieValue.current }) }),
  headers: async () => new Headers({ 'x-forwarded-for': forwardedFor.current }),
}));

import { POST as connect } from '@/app/api/connect/route';
import { GET as events } from '@/app/api/executions/[id]/events/route';
import { GET as proxy } from '@/app/api/proxy/[...path]/route';
import { apiFetch } from '@/lib/api';
import { ApiError } from '@/lib/api-error';
import { clientAddressHeaders } from '@/lib/client-address';

const ORIGIN = 'http://localhost:3001';
const SECRET = 'client-address-secret-for-frontend-tests';
const EXECUTION_ID = '0b9c3f9e-8c1e-4c6f-9a55-2f1b5d0f3a11';

function request(path: string, init: { method?: string; body?: string; cookie?: string } = {}) {
  const headers = new Headers({ host: 'localhost:3001', origin: ORIGIN, 'x-forwarded-for': '198.51.100.1, 203.0.113.9' });
  if (init.cookie) headers.set('cookie', `ff_api_key=${init.cookie}`);
  if (init.body) headers.set('content-type', 'application/json');
  return new NextRequest(new URL(path, ORIGIN), { method: init.method ?? 'GET', headers, body: init.body });
}

describe('forwarding the client address to the API', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv('CLIENT_ADDRESS_SECRET', SECRET);
    vi.stubEnv('TRUSTED_PROXY_HOPS', '0');
    cookieValue.current = undefined;
    fetchMock = vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('takes the address the nearest trusted hop saw', () => {
    expect(clientAddressHeaders(new Headers({ 'x-forwarded-for': '198.51.100.1, 203.0.113.9' }))).toEqual({
      'x-client-address': '203.0.113.9',
      'x-client-address-secret': SECRET,
    });
    vi.stubEnv('TRUSTED_PROXY_HOPS', '1');
    expect(clientAddressHeaders(new Headers({ 'x-forwarded-for': '198.51.100.1, 203.0.113.9' }))['x-client-address']).toBe('198.51.100.1');
  });

  it('sends nothing without a secret or without a valid address', () => {
    expect(clientAddressHeaders(new Headers({ 'x-forwarded-for': 'not-an-address' }))).toEqual({});
    vi.stubEnv('CLIENT_ADDRESS_SECRET', '');
    expect(clientAddressHeaders(new Headers({ 'x-forwarded-for': '203.0.113.9' }))).toEqual({});
  });

  it('is sent by the connect, proxy and live events routes', async () => {
    await connect(request('/api/connect', { method: 'POST', body: '{"apiKey":"ff_key"}' }));
    await proxy(request('/api/proxy/workflows', { cookie: 'ff_key' }), { params: Promise.resolve({ path: ['workflows'] }) });
    await events(request(`/api/executions/${EXECUTION_ID}/events`, { cookie: 'ff_key' }), { params: Promise.resolve({ id: EXECUTION_ID }) });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers).toMatchObject({ 'x-client-address': '203.0.113.9', 'x-client-address-secret': SECRET });
    }
  });

  it('is sent with server side page requests', async () => {
    cookieValue.current = 'ff_key';

    await apiFetch('/workflows');

    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ 'x-api-key': 'ff_key', 'x-client-address': '203.0.113.5' });
  });
});

describe('server side page requests without a connected key', () => {
  it('fail as unauthenticated without calling the API', async () => {
    cookieValue.current = undefined;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const failure = await apiFetch('/workflows').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('connect when the API limits failed attempts', () => {
  it('answers too many requests with the retry delay instead of a gateway error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429, headers: { 'retry-after': '17' } })));

    const res = await connect(request('/api/connect', { method: 'POST', body: '{"apiKey":"ff_key"}' }));

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('17');
    expect((await res.json()).message).toBe('Too many failed attempts. Try again later.');
  });
});

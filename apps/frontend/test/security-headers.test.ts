import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import config from '../next.config.js';
import { middleware } from '@/middleware';

const page = () => new NextRequest(new URL('/workflows', 'http://localhost:3001'));

function directives(policy: string | null): Map<string, string[]> {
  return new Map(
    (policy ?? '')
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map(([name, ...values]) => [name, values]),
  );
}

describe('security headers', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sends frame, sniffing and referrer rules on every path and no X-Powered-By', async () => {
    const rules = await config.headers();
    const [all] = rules.filter((rule) => rule.source === '/:path*');
    const headers = Object.fromEntries(all.headers.map((h) => [h.key.toLowerCase(), h.value]));

    expect(config.poweredByHeader).toBe(false);
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('same-origin');
    expect(headers['x-frame-options']).toBe('DENY');
  });

  it('sends a content security policy on every page', () => {
    const csp = directives(middleware(page()).headers.get('content-security-policy'));

    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
    expect(csp.get('object-src')).toEqual(["'none'"]);
    expect(csp.get('default-src')).toEqual(["'self'"]);
    expect(csp.get('base-uri')).toEqual(["'self'"]);
    expect(csp.get('form-action')).toEqual(["'self'"]);
    expect(csp.get('connect-src')).toEqual(["'self'"]);
  });

  it('allows in production only the scripts that carry the nonce of this response', () => {
    vi.stubEnv('NODE_ENV', 'production');

    const res = middleware(page());
    const script = directives(res.headers.get('content-security-policy')).get('script-src') ?? [];

    expect(script).toContain("'strict-dynamic'");
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
    expect(script.filter((source) => /^'nonce-[A-Za-z0-9+/=]{16,}'$/.test(source))).toHaveLength(1);
  });

  it('gives every response its own nonce and hands the same policy to the page renderer', () => {
    vi.stubEnv('NODE_ENV', 'production');

    const first = middleware(page());
    const second = middleware(page());

    const policy = first.headers.get('content-security-policy');
    expect(policy).not.toBe(second.headers.get('content-security-policy'));
    expect(first.headers.get('x-middleware-request-content-security-policy')).toBe(policy);
    expect(first.headers.get('x-middleware-override-headers')).toContain('content-security-policy');
  });

  it('tells browsers to use https only when the site is served over https', () => {
    vi.stubEnv('APP_ORIGIN', 'https://flowforge.example');
    expect(middleware(page()).headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');

    vi.stubEnv('APP_ORIGIN', 'http://localhost:3001');
    expect(middleware(page()).headers.get('strict-transport-security')).toBeNull();

    vi.stubEnv('APP_ORIGIN', '');
    expect(middleware(page()).headers.get('strict-transport-security')).toBeNull();
  });
});

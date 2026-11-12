import { describe, expect, it } from 'vitest';
import config from '../next.config.js';

describe('security headers', () => {
  it('sends a content security policy, frame, sniffing and referrer rules on every page and no X-Powered-By', async () => {
    const rules = await config.headers();
    const [all] = rules.filter((rule) => rule.source === '/:path*');
    const headers = Object.fromEntries(all.headers.map((h) => [h.key.toLowerCase(), h.value]));

    expect(config.poweredByHeader).toBe(false);
    expect(headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(headers['content-security-policy']).toMatch(/object-src 'none'/);
    expect(headers['content-security-policy']).toMatch(/default-src 'self'/);
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('same-origin');
    expect(headers['x-frame-options']).toBe('DENY');
  });
});

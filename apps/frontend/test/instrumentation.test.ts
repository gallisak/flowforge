import { afterEach, beforeEach, describe, expect, it, MockInstance, vi } from 'vitest';
import { register } from '@/instrumentation';

describe('configuration check at server start', () => {
  let exit: MockInstance<typeof process.exit>;
  let logged: MockInstance<typeof console.error>;

  beforeEach(() => {
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('NEXT_PHASE', '');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('API_URL', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('stops the server with every problem logged instead of serving errors', () => {
    vi.stubEnv('CLIENT_ADDRESS_SECRET', 'short');

    expect(() => register()).not.toThrow();

    expect(exit).toHaveBeenCalledWith(1);
    const output = logged.mock.calls.flat().join(' ');
    expect(output).toContain('API_URL is required in production');
    expect(output).toContain('CLIENT_ADDRESS_SECRET must be at least 32 characters');
  });

  it('starts normally with a valid configuration', () => {
    vi.stubEnv('API_URL', 'http://api:3000');

    register();

    expect(exit).not.toHaveBeenCalled();
  });

  it('does not stop a production build, which runs without the runtime configuration', () => {
    vi.stubEnv('NEXT_PHASE', 'phase-production-build');

    expect(() => register()).not.toThrow();

    expect(exit).not.toHaveBeenCalled();
  });

  it('leaves the check to the Node.js runtime', () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');

    expect(() => register()).not.toThrow();

    expect(exit).not.toHaveBeenCalled();
  });
});

import { ConfigError, loadApiConfig, loadMigrationConfig, loadWorkerConfig } from '../src/config/config';

const DATABASE_URL = 'postgres://flowforge_app:secret-password@localhost:5432/flowforge';
const STRONG_TOKEN = 'a'.repeat(16) + 'b'.repeat(16) + 'c'.repeat(16);

function problemsOf(load: () => unknown): string[] {
  try {
    load();
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

describe('loadApiConfig', () => {
  it('applies defaults for optional settings', () => {
    const config = loadApiConfig({ DATABASE_URL, ADMIN_TOKEN: 'dev-admin-token' });
    expect(config).toEqual({
      nodeEnv: 'development',
      port: 3000,
      databaseUrl: DATABASE_URL,
      adminToken: 'dev-admin-token',
      schedulerTickMs: 30_000,
    });
  });

  it('reports every missing required setting at once', () => {
    expect(problemsOf(() => loadApiConfig({}))).toEqual(['DATABASE_URL is required', 'ADMIN_TOKEN is required']);
  });

  it('accepts the development placeholder admin token outside production', () => {
    expect(loadApiConfig({ DATABASE_URL, ADMIN_TOKEN: 'change-me-admin' }).adminToken).toBe('change-me-admin');
  });

  it('rejects a placeholder admin token in production', () => {
    expect(problemsOf(() => loadApiConfig({ NODE_ENV: 'production', DATABASE_URL, ADMIN_TOKEN: 'change-me-admin' }))).toEqual([
      'ADMIN_TOKEN must be a random secret of at least 32 characters in production',
    ]);
  });

  it('rejects a long admin token that still looks like a placeholder in production', () => {
    const token = `change-me-${'x'.repeat(40)}`;
    expect(problemsOf(() => loadApiConfig({ NODE_ENV: 'production', DATABASE_URL, ADMIN_TOKEN: token }))).toHaveLength(1);
  });

  it('accepts a strong admin token in production', () => {
    expect(loadApiConfig({ NODE_ENV: 'production', DATABASE_URL, ADMIN_TOKEN: STRONG_TOKEN }).nodeEnv).toBe('production');
  });

  it('rejects short admin tokens in development', () => {
    expect(problemsOf(() => loadApiConfig({ DATABASE_URL, ADMIN_TOKEN: 'short' }))).toEqual([
      'ADMIN_TOKEN must be at least 8 characters',
    ]);
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', '70000'],
    ['PORT', '1.5'],
    ['SCHEDULER_TICK_MS', '10'],
  ])('rejects %s=%s', (name, value) => {
    expect(problemsOf(() => loadApiConfig({ DATABASE_URL, ADMIN_TOKEN: 'dev-admin-token', [name]: value }))).toEqual([
      expect.stringMatching(new RegExp(`^${name} must be an integer`)),
    ]);
  });

  it.each(['not a url', 'mysql://localhost/db'])('rejects DATABASE_URL=%s', (value) => {
    expect(problemsOf(() => loadApiConfig({ DATABASE_URL: value, ADMIN_TOKEN: 'dev-admin-token' }))).toHaveLength(1);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(problemsOf(() => loadApiConfig({ NODE_ENV: 'staging', DATABASE_URL, ADMIN_TOKEN: 'dev-admin-token' }))).toEqual([
      'NODE_ENV must be one of development, test, production',
    ]);
  });

  it('never includes secret values in error messages', () => {
    const error = (() => {
      try {
        loadApiConfig({ NODE_ENV: 'production', DATABASE_URL: 'mysql://u:secret-password@h/db', ADMIN_TOKEN: 'change-me-admin' });
      } catch (e) {
        return e as Error;
      }
      throw new Error('expected loadApiConfig to throw');
    })();
    expect(error.message).not.toMatch(/secret-password|change-me-admin/);
  });

  it('returns an immutable config object', () => {
    const config = loadApiConfig({ DATABASE_URL, ADMIN_TOKEN: 'dev-admin-token' });
    expect(Object.isFrozen(config)).toBe(true);
  });
});

describe('loadWorkerConfig', () => {
  it('does not require an admin token', () => {
    expect(loadWorkerConfig({ DATABASE_URL })).toEqual({
      nodeEnv: 'development',
      databaseUrl: DATABASE_URL,
      workerConcurrency: 4,
      leaseSeconds: 30,
      reaperIntervalMs: 5_000,
      shutdownGraceMs: 25_000,
    });
  });

  it.each([
    ['WORKER_LEASE_SECONDS', '1'],
    ['WORKER_REAPER_INTERVAL_MS', '50'],
  ])('rejects %s=%s', (name, value) => {
    expect(problemsOf(() => loadWorkerConfig({ DATABASE_URL, [name]: value }))).toEqual([
      expect.stringMatching(new RegExp(`^${name} must be an integer`)),
    ]);
  });

  it.each(['0', '65', 'many'])('rejects WORKER_CONCURRENCY=%s', (value) => {
    expect(problemsOf(() => loadWorkerConfig({ DATABASE_URL, WORKER_CONCURRENCY: value }))).toEqual([
      'WORKER_CONCURRENCY must be an integer between 1 and 64',
    ]);
  });
});

describe('loadMigrationConfig', () => {
  it('requires MIGRATION_DATABASE_URL', () => {
    expect(problemsOf(() => loadMigrationConfig({ DATABASE_URL }))).toEqual(['MIGRATION_DATABASE_URL is required']);
  });
});

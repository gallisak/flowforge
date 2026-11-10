import { DatabaseTimeouts } from '../db/data-source';

type Env = Record<string, string | undefined>;

export type NodeEnv = 'development' | 'test' | 'production';

export interface ApiConfig {
  nodeEnv: NodeEnv;
  port: number;
  databaseUrl: string;
  databaseTimeouts: DatabaseTimeouts;
  adminToken: string;
  schedulerTickMs: number;
  webhookToleranceSeconds: number;
  webhookSecretGraceSeconds: number;
}

export interface WorkerConfig {
  nodeEnv: NodeEnv;
  databaseUrl: string;
  databaseTimeouts: DatabaseTimeouts;
  workerConcurrency: number;
  leaseSeconds: number;
  reaperIntervalMs: number;
  shutdownGraceMs: number;
  retryBaseMs: number;
  retryCapMs: number;
  transformTimeoutMs: number;
  transformMemoryMb: number;
  httpTimeoutMs: number;
  httpMaxRedirects: number;
  httpMaxResponseBytes: number;
  stepOutputMaxBytes: number;
  ssrfAllowlist: readonly string[];
}

export interface MigrationConfig {
  migrationDatabaseUrl: string;
}

export const API_CONFIG = Symbol('API_CONFIG');
export const WORKER_CONFIG = Symbol('WORKER_CONFIG');

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
  }
}

const NODE_ENVS: readonly NodeEnv[] = ['development', 'test', 'production'];
const PRODUCTION_ADMIN_TOKEN_MIN_LENGTH = 32;
const ADMIN_TOKEN_MIN_LENGTH = 8;
const ALLOWLIST_ENTRY = /^(\[[0-9a-f:.]+\]|[a-z0-9-]+(\.[a-z0-9-]+)*\.?)(:\d{1,5})?$/;

class EnvReader {
  readonly problems: string[] = [];

  constructor(private readonly env: Env) {}

  nodeEnv(): NodeEnv {
    const raw = this.env.NODE_ENV ?? 'development';
    if (!NODE_ENVS.includes(raw as NodeEnv)) {
      this.problems.push(`NODE_ENV must be one of ${NODE_ENVS.join(', ')}`);
      return 'development';
    }
    return raw as NodeEnv;
  }

  integer(name: string, fallback: number, min: number, max: number): number {
    const raw = this.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      this.problems.push(`${name} must be an integer between ${min} and ${max}`);
      return fallback;
    }
    return value;
  }

  postgresUrl(name: string): string {
    const raw = this.env[name];
    if (!raw) {
      this.problems.push(`${name} is required`);
      return '';
    }
    let protocol: string;
    try {
      protocol = new URL(raw).protocol;
    } catch {
      this.problems.push(`${name} must be a valid URL`);
      return '';
    }
    if (protocol !== 'postgres:' && protocol !== 'postgresql:') {
      this.problems.push(`${name} must use the postgres:// scheme`);
    }
    return raw;
  }

  databaseTimeouts(): DatabaseTimeouts {
    return {
      connectTimeoutMs: this.integer('DB_CONNECT_TIMEOUT_MS', 5_000, 100, 120_000),
      statementTimeoutMs: this.integer('DB_STATEMENT_TIMEOUT_MS', 15_000, 100, 600_000),
    };
  }

  adminToken(nodeEnv: NodeEnv): string {
    const token = this.env.ADMIN_TOKEN ?? '';
    if (token.length === 0) {
      this.problems.push('ADMIN_TOKEN is required');
    } else if (nodeEnv === 'production') {
      if (token.length < PRODUCTION_ADMIN_TOKEN_MIN_LENGTH || /change-?me/i.test(token)) {
        this.problems.push(
          `ADMIN_TOKEN must be a random secret of at least ${PRODUCTION_ADMIN_TOKEN_MIN_LENGTH} characters in production`,
        );
      }
    } else if (token.length < ADMIN_TOKEN_MIN_LENGTH) {
      this.problems.push(`ADMIN_TOKEN must be at least ${ADMIN_TOKEN_MIN_LENGTH} characters`);
    }
    return token;
  }

  allowlist(name: string): string[] {
    const entries = (this.env[name] ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0);
    const invalid = entries.filter((entry) => !ALLOWLIST_ENTRY.test(entry));
    if (invalid.length > 0) this.problems.push(`${name} entries must look like host or host:port`);
    return entries;
  }

  done<T>(config: T): T {
    if (this.problems.length > 0) throw new ConfigError(this.problems);
    return Object.freeze(config);
  }
}

export function loadApiConfig(env: Env = process.env): ApiConfig {
  const read = new EnvReader(env);
  const nodeEnv = read.nodeEnv();
  return read.done({
    nodeEnv,
    port: read.integer('PORT', 3000, 0, 65_535),
    databaseUrl: read.postgresUrl('DATABASE_URL'),
    databaseTimeouts: read.databaseTimeouts(),
    adminToken: read.adminToken(nodeEnv),
    schedulerTickMs: read.integer('SCHEDULER_TICK_MS', 30_000, 1_000, 3_600_000),
    webhookToleranceSeconds: read.integer('WEBHOOK_TOLERANCE_SECONDS', 300, 10, 3_600),
    webhookSecretGraceSeconds: read.integer('WEBHOOK_SECRET_GRACE_SECONDS', 86_400, 0, 2_592_000),
  });
}

export function loadWorkerConfig(env: Env = process.env): WorkerConfig {
  const read = new EnvReader(env);
  const retryBaseMs = read.integer('RETRY_BASE_MS', 1_000, 10, 600_000);
  const retryCapMs = read.integer('RETRY_CAP_MS', 300_000, 10, 86_400_000);
  if (retryCapMs < retryBaseMs) read.problems.push('RETRY_CAP_MS must not be smaller than RETRY_BASE_MS');
  return read.done({
    nodeEnv: read.nodeEnv(),
    databaseUrl: read.postgresUrl('DATABASE_URL'),
    databaseTimeouts: read.databaseTimeouts(),
    workerConcurrency: read.integer('WORKER_CONCURRENCY', 4, 1, 64),
    leaseSeconds: read.integer('WORKER_LEASE_SECONDS', 30, 2, 3_600),
    reaperIntervalMs: read.integer('WORKER_REAPER_INTERVAL_MS', 5_000, 100, 600_000),
    shutdownGraceMs: read.integer('WORKER_SHUTDOWN_GRACE_MS', 25_000, 0, 600_000),
    retryBaseMs,
    retryCapMs,
    transformTimeoutMs: read.integer('TRANSFORM_TIMEOUT_MS', 100, 10, 10_000),
    transformMemoryMb: read.integer('TRANSFORM_MEMORY_MB', 32, 4, 512),
    httpTimeoutMs: read.integer('HTTP_TIMEOUT_MS', 15_000, 100, 120_000),
    httpMaxRedirects: read.integer('HTTP_MAX_REDIRECTS', 5, 0, 10),
    httpMaxResponseBytes: read.integer('HTTP_MAX_RESPONSE_BYTES', 1_048_576, 1_024, 67_108_864),
    stepOutputMaxBytes: read.integer('STEP_OUTPUT_MAX_BYTES', 1_048_576, 1_024, 16_777_216),
    ssrfAllowlist: read.allowlist('SSRF_ALLOWLIST'),
  });
}

export function loadMigrationConfig(env: Env = process.env): MigrationConfig {
  const read = new EnvReader(env);
  return read.done({ migrationDatabaseUrl: read.postgresUrl('MIGRATION_DATABASE_URL') });
}

export function loadConfigOrExit<T>(load: () => T): T {
  try {
    return load();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

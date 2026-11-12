import { isIP } from 'net';
import { DatabaseTimeouts } from '../db/data-source';
import { LOG_LEVELS, LogLevelName } from '../observability/logger';

type Env = Record<string, string | undefined>;

export type NodeEnv = 'development' | 'test' | 'production';

export type TrustProxy = false | number | string[];

export interface ObservabilityConfig {
  logLevel: LogLevelName;
  metricsPort: number;
}

export interface OutboxConfig {
  pollIntervalMs: number;
  concurrency: number;
  tenantConcurrency: number;
  leaseSeconds: number;
  maxAttempts: number;
  retryBaseMs: number;
  retryCapMs: number;
  timeoutMs: number;
}

export interface ApiConfig extends ObservabilityConfig {
  nodeEnv: NodeEnv;
  port: number;
  metricsTopTenants: number;
  executionStreamsPerTenant: number;
  executionEventsPingMs: number;
  databaseUrl: string;
  databaseTimeouts: DatabaseTimeouts;
  databasePoolSize: number;
  adminToken: string;
  webhookToleranceSeconds: number;
  webhookSecretGraceSeconds: number;
  tenantRateLimitPerMinute: number;
  authFailuresPerMinute: number;
  clientAddressSecret: string;
  trustProxy: TrustProxy;
  tenantMaxQueuedJobs: number;
  tenantMaxWorkflows: number;
  jobMaxAttempts: number;
  ssrfAllowlist: readonly string[];
}

export interface WorkerConfig extends ObservabilityConfig {
  nodeEnv: NodeEnv;
  databaseUrl: string;
  databaseTimeouts: DatabaseTimeouts;
  databasePoolSize: number;
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
  executionOutputMaxBytes: number;
  ssrfAllowlist: readonly string[];
  tenantMaxConcurrentJobs: number;
  retentionDays: number;
  retentionIntervalMs: number;
  outbox: OutboxConfig;
}

export interface SchedulerConfig extends ObservabilityConfig {
  nodeEnv: NodeEnv;
  databaseUrl: string;
  databaseTimeouts: DatabaseTimeouts;
  databasePoolSize: number;
  schedulerTickMs: number;
  schedulerMisfireGraceMs: number;
  schedulerMaxCatchUpRuns: number;
  schedulerPostponeMs: number;
  tenantMaxQueuedJobs: number;
  jobMaxAttempts: number;
}

export interface QueueLimits {
  tenantMaxQueuedJobs: number;
  jobMaxAttempts: number;
}

export interface WorkflowLimits {
  tenantMaxWorkflows: number;
}

export interface MigrationConfig {
  migrationDatabaseUrl: string;
  connectTimeoutMs: number;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
}

export const API_CONFIG = Symbol('API_CONFIG');
export const WORKER_CONFIG = Symbol('WORKER_CONFIG');
export const SCHEDULER_CONFIG = Symbol('SCHEDULER_CONFIG');
export const QUEUE_LIMITS = Symbol('QUEUE_LIMITS');
export const WORKFLOW_LIMITS = Symbol('WORKFLOW_LIMITS');

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
  }
}

const NODE_ENVS: readonly NodeEnv[] = ['development', 'test', 'production'];
const PRODUCTION_ADMIN_TOKEN_MIN_LENGTH = 32;
const ADMIN_TOKEN_MIN_LENGTH = 8;
const DEFAULT_POOL_SIZE = 10;
const SPARE_WORKER_CONNECTIONS = 2;
const COMPOSE_STOP_GRACE_PERIOD_MS = 30_000;
const RELEASE_JOBS_AFTER_GRACE_MS = 5_000;
const MAX_WORKER_SHUTDOWN_GRACE_MS = COMPOSE_STOP_GRACE_PERIOD_MS - RELEASE_JOBS_AFTER_GRACE_MS;
const CLIENT_ADDRESS_SECRET_MIN_LENGTH = 32;
const TRUST_PROXY_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);
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

  clientAddressSecret(): string {
    const secret = this.env.CLIENT_ADDRESS_SECRET ?? '';
    if (secret.length > 0 && secret.length < CLIENT_ADDRESS_SECRET_MIN_LENGTH) {
      this.problems.push(`CLIENT_ADDRESS_SECRET must be at least ${CLIENT_ADDRESS_SECRET_MIN_LENGTH} characters`);
    }
    return secret;
  }

  trustProxy(): TrustProxy {
    const raw = (this.env.TRUST_PROXY ?? '').trim();
    if (raw === '') return false;
    if (/^\d+$/.test(raw)) return this.integer('TRUST_PROXY', 0, 0, 10) || false;
    const entries = raw.split(',').map((entry) => entry.trim().toLowerCase());
    const valid = entries.every((entry) => {
      if (TRUST_PROXY_KEYWORDS.has(entry)) return true;
      const [address, prefix, ...rest] = entry.split('/');
      const family = isIP(address);
      if (family === 0 || rest.length > 0) return false;
      if (prefix === undefined) return true;
      const bits = Number(prefix);
      return /^\d+$/.test(prefix) && bits <= (family === 4 ? 32 : 128);
    });
    if (!valid) this.problems.push('TRUST_PROXY must be a hop count or a comma separated list of addresses, subnets, loopback, linklocal or uniquelocal');
    return entries;
  }

  logLevel(): LogLevelName {
    const raw = (this.env.LOG_LEVEL ?? 'info').toLowerCase();
    if (!LOG_LEVELS.includes(raw as LogLevelName)) {
      this.problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);
      return 'info';
    }
    return raw as LogLevelName;
  }

  observability(): ObservabilityConfig {
    return { logLevel: this.logLevel(), metricsPort: this.integer('METRICS_PORT', 9_100, 0, 65_535) };
  }

  outbox(): OutboxConfig {
    const retryBaseMs = this.integer('OUTBOX_RETRY_BASE_MS', 30_000, 10, 3_600_000);
    const retryCapMs = this.integer('OUTBOX_RETRY_CAP_MS', 3_600_000, 10, 86_400_000);
    if (retryCapMs < retryBaseMs) this.problems.push('OUTBOX_RETRY_CAP_MS must not be smaller than OUTBOX_RETRY_BASE_MS');
    const leaseSeconds = this.integer('OUTBOX_LEASE_SECONDS', 30, 2, 3_600);
    const timeoutMs = this.integer('OUTBOX_TIMEOUT_MS', 10_000, 100, 120_000);
    if (timeoutMs >= leaseSeconds * 1_000) this.problems.push('OUTBOX_TIMEOUT_MS must be shorter than OUTBOX_LEASE_SECONDS');
    return {
      pollIntervalMs: this.integer('OUTBOX_POLL_INTERVAL_MS', 1_000, 50, 60_000),
      concurrency: this.integer('OUTBOX_CONCURRENCY', 10, 1, 100),
      tenantConcurrency: this.integer('OUTBOX_TENANT_CONCURRENCY', 2, 1, 100),
      leaseSeconds,
      maxAttempts: this.integer('OUTBOX_MAX_ATTEMPTS', 15, 1, 100),
      retryBaseMs,
      retryCapMs,
      timeoutMs,
    };
  }

  jobMaxAttempts(): number {
    return this.integer('JOB_MAX_ATTEMPTS', 8, 1, 100);
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
  const port = read.integer('PORT', 3000, 0, 65_535);
  const observability = read.observability();
  if (port !== 0 && port === observability.metricsPort) read.problems.push('PORT and METRICS_PORT must be different ports');
  return read.done({
    nodeEnv,
    port,
    ...observability,
    metricsTopTenants: read.integer('METRICS_TOP_TENANTS', 20, 1, 1_000),
    executionStreamsPerTenant: read.integer('EXECUTION_STREAMS_PER_TENANT', 20, 1, 10_000),
    executionEventsPingMs: read.integer('EXECUTION_EVENTS_PING_MS', 30_000, 100, 600_000),
    databaseUrl: read.postgresUrl('DATABASE_URL'),
    databaseTimeouts: read.databaseTimeouts(),
    databasePoolSize: read.integer('DB_POOL_SIZE', DEFAULT_POOL_SIZE, 2, 1_000),
    adminToken: read.adminToken(nodeEnv),
    webhookToleranceSeconds: read.integer('WEBHOOK_TOLERANCE_SECONDS', 300, 10, 3_600),
    webhookSecretGraceSeconds: read.integer('WEBHOOK_SECRET_GRACE_SECONDS', 86_400, 0, 2_592_000),
    tenantRateLimitPerMinute: read.integer('TENANT_RATE_LIMIT_PER_MINUTE', 600, 1, 1_000_000),
    authFailuresPerMinute: read.integer('AUTH_FAILURES_PER_MINUTE', 60, 1, 1_000_000),
    clientAddressSecret: read.clientAddressSecret(),
    trustProxy: read.trustProxy(),
    tenantMaxQueuedJobs: read.integer('TENANT_MAX_QUEUED_JOBS', 10_000, 1, 10_000_000),
    tenantMaxWorkflows: read.integer('TENANT_MAX_WORKFLOWS', 1_000, 1, 1_000_000),
    jobMaxAttempts: read.jobMaxAttempts(),
    ssrfAllowlist: read.allowlist('SSRF_ALLOWLIST'),
  });
}

export function loadSchedulerConfig(env: Env = process.env): SchedulerConfig {
  const read = new EnvReader(env);
  const schedulerTickMs = read.integer('SCHEDULER_TICK_MS', 5_000, 1_000, 3_600_000);
  const schedulerMisfireGraceMs = read.integer('SCHEDULER_MISFIRE_GRACE_MS', 60_000, 1_000, 3_600_000);
  const schedulerPostponeMs = read.integer('SCHEDULER_POSTPONE_MS', 30_000, 100, 3_600_000);
  if (schedulerTickMs >= schedulerMisfireGraceMs) read.problems.push('SCHEDULER_TICK_MS must be shorter than SCHEDULER_MISFIRE_GRACE_MS');
  if (schedulerPostponeMs >= schedulerMisfireGraceMs) read.problems.push('SCHEDULER_POSTPONE_MS must be shorter than SCHEDULER_MISFIRE_GRACE_MS');
  return read.done({
    nodeEnv: read.nodeEnv(),
    databaseUrl: read.postgresUrl('DATABASE_URL'),
    databaseTimeouts: read.databaseTimeouts(),
    databasePoolSize: read.integer('DB_POOL_SIZE', DEFAULT_POOL_SIZE, 2, 1_000),
    ...read.observability(),
    schedulerTickMs,
    schedulerMisfireGraceMs,
    schedulerMaxCatchUpRuns: read.integer('SCHEDULER_MAX_CATCH_UP_RUNS', 100, 1, 1_000),
    schedulerPostponeMs,
    tenantMaxQueuedJobs: read.integer('TENANT_MAX_QUEUED_JOBS', 10_000, 1, 10_000_000),
    jobMaxAttempts: read.jobMaxAttempts(),
  });
}

export function loadWorkerConfig(env: Env = process.env): WorkerConfig {
  const read = new EnvReader(env);
  const retryBaseMs = read.integer('RETRY_BASE_MS', 1_000, 10, 600_000);
  const retryCapMs = read.integer('RETRY_CAP_MS', 300_000, 10, 86_400_000);
  if (retryCapMs < retryBaseMs) read.problems.push('RETRY_CAP_MS must not be smaller than RETRY_BASE_MS');
  const stepOutputMaxBytes = read.integer('STEP_OUTPUT_MAX_BYTES', 1_048_576, 1_024, 16_777_216);
  const executionOutputMaxBytes = read.integer('EXECUTION_OUTPUT_MAX_BYTES', 16_777_216, 1_024, 268_435_456);
  const workerConcurrency = read.integer('WORKER_CONCURRENCY', 4, 1, 64);
  const outbox = read.outbox();
  const neededConnections = 2 * workerConcurrency + outbox.concurrency + SPARE_WORKER_CONNECTIONS;
  const databasePoolSize = read.integer('DB_POOL_SIZE', neededConnections, 2, 1_000);
  if (databasePoolSize < neededConnections) {
    read.problems.push(
      `DB_POOL_SIZE must be at least ${neededConnections} for WORKER_CONCURRENCY=${workerConcurrency} and OUTBOX_CONCURRENCY=${outbox.concurrency}`,
    );
  }
  if (executionOutputMaxBytes < stepOutputMaxBytes) {
    read.problems.push('EXECUTION_OUTPUT_MAX_BYTES must not be smaller than STEP_OUTPUT_MAX_BYTES');
  }
  const databaseTimeouts = read.databaseTimeouts();
  const leaseSeconds = read.integer('WORKER_LEASE_SECONDS', 30, 2, 3_600);
  if (leaseSeconds * 1_000 <= databaseTimeouts.statementTimeoutMs) {
    read.problems.push('WORKER_LEASE_SECONDS must be longer than DB_STATEMENT_TIMEOUT_MS');
  }
  return read.done({
    nodeEnv: read.nodeEnv(),
    databaseUrl: read.postgresUrl('DATABASE_URL'),
    databaseTimeouts,
    databasePoolSize,
    workerConcurrency,
    leaseSeconds,
    reaperIntervalMs: read.integer('WORKER_REAPER_INTERVAL_MS', 5_000, 100, 600_000),
    shutdownGraceMs: read.integer('WORKER_SHUTDOWN_GRACE_MS', 25_000, 0, MAX_WORKER_SHUTDOWN_GRACE_MS),
    retryBaseMs,
    retryCapMs,
    transformTimeoutMs: read.integer('TRANSFORM_TIMEOUT_MS', 100, 10, 10_000),
    transformMemoryMb: read.integer('TRANSFORM_MEMORY_MB', 32, 4, 512),
    httpTimeoutMs: read.integer('HTTP_TIMEOUT_MS', 15_000, 100, 120_000),
    httpMaxRedirects: read.integer('HTTP_MAX_REDIRECTS', 5, 0, 10),
    httpMaxResponseBytes: read.integer('HTTP_MAX_RESPONSE_BYTES', 1_048_576, 1_024, 67_108_864),
    stepOutputMaxBytes,
    executionOutputMaxBytes,
    ssrfAllowlist: read.allowlist('SSRF_ALLOWLIST'),
    tenantMaxConcurrentJobs: read.integer('TENANT_MAX_CONCURRENT_JOBS', 10, 1, 10_000),
    retentionDays: read.integer('RETENTION_DAYS', 30, 0, 3_650),
    retentionIntervalMs: read.integer('RETENTION_INTERVAL_MS', 600_000, 100, 86_400_000),
    ...read.observability(),
    outbox,
  });
}

export function loadMigrationConfig(env: Env = process.env): MigrationConfig {
  const read = new EnvReader(env);
  return read.done({
    migrationDatabaseUrl: read.postgresUrl('MIGRATION_DATABASE_URL'),
    connectTimeoutMs: read.integer('DB_CONNECT_TIMEOUT_MS', 5_000, 100, 120_000),
    statementTimeoutMs: read.integer('MIGRATION_STATEMENT_TIMEOUT_MS', 600_000, 1_000, 86_400_000),
    lockTimeoutMs: read.integer('MIGRATION_LOCK_TIMEOUT_MS', 5_000, 100, 600_000),
  });
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

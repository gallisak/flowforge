type Env = Record<string, string | undefined>;

export type NodeEnv = 'development' | 'test' | 'production';

export interface ApiConfig {
  nodeEnv: NodeEnv;
  port: number;
  databaseUrl: string;
  adminToken: string;
  schedulerTickMs: number;
}

export interface WorkerConfig {
  nodeEnv: NodeEnv;
  databaseUrl: string;
  workerConcurrency: number;
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
    adminToken: read.adminToken(nodeEnv),
    schedulerTickMs: read.integer('SCHEDULER_TICK_MS', 30_000, 1_000, 3_600_000),
  });
}

export function loadWorkerConfig(env: Env = process.env): WorkerConfig {
  const read = new EnvReader(env);
  return read.done({
    nodeEnv: read.nodeEnv(),
    databaseUrl: read.postgresUrl('DATABASE_URL'),
    workerConcurrency: read.integer('WORKER_CONCURRENCY', 4, 1, 64),
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

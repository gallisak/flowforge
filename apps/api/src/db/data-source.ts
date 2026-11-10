import { DataSourceOptions } from 'typeorm';
import { Execution, Job, StepRun, Tenant, Workflow } from '../entities';
import { migrations } from '../migrations';

export const entities = [Tenant, Workflow, Execution, StepRun, Job];

export interface DatabaseTimeouts {
  connectTimeoutMs: number;
  statementTimeoutMs: number;
}

const CLIENT_TIMEOUT_MARGIN_MS = 5_000;

export function dataSourceOptions(url: string, timeouts?: DatabaseTimeouts): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    entities,
    migrations,
    synchronize: false,
    migrationsRun: false,
    uuidExtension: 'pgcrypto',
    installExtensions: false,
    extra: timeouts && {
      connectionTimeoutMillis: timeouts.connectTimeoutMs,
      statement_timeout: timeouts.statementTimeoutMs,
      query_timeout: timeouts.statementTimeoutMs + CLIENT_TIMEOUT_MARGIN_MS,
      idle_in_transaction_session_timeout: timeouts.statementTimeoutMs * 2,
      keepAlive: true,
    },
  };
}

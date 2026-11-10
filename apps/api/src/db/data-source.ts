import { DataSourceOptions } from 'typeorm';
import { Execution, Job, StepRun, Tenant, Workflow } from '../entities';
import { migrations } from '../migrations';

export const entities = [Tenant, Workflow, Execution, StepRun, Job];

export function dataSourceOptions(url: string): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    entities,
    migrations,
    synchronize: false,
    migrationsRun: false,
    uuidExtension: 'pgcrypto',
    installExtensions: false,
  };
}

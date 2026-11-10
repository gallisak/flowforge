import { execFile } from 'child_process';
import { join } from 'path';
import { promisify } from 'util';
import { runMigrations } from '../../src/db/run-migrations';
import { postgresContainerRegistry } from './container';

export const TEMPLATE_DB = 'ff_template';
export const EMPTY_TEMPLATE_DB = 'ff_template_empty';
export const PROVISION_SQL = join(__dirname, '..', '..', '..', '..', 'docker', 'postgres', 'provision.sql');
export const PROVISION_SQL_IN_CONTAINER = '/flowforge/provision.sql';

export const DB_ROLES = {
  owner: { user: 'flowforge_owner', password: 'flowforge_owner' },
  app: { user: 'flowforge_app', password: 'flowforge_app' },
} as const;

export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export function withCredentials(url: string, credentials: { user: string; password: string }): string {
  const u = new URL(url);
  u.username = credentials.user;
  u.password = credentials.password;
  return u.toString();
}

async function provisionDatabase(adminUrl: string, database: string): Promise<void> {
  const variables = [
    '-v', `owner_password=${DB_ROLES.owner.password}`,
    '-v', `app_password=${DB_ROLES.app.password}`,
  ];
  const container = postgresContainerRegistry.flowforgeTestPostgres;
  if (container) {
    const result = await container.exec([
      'psql', '-U', container.getUsername(), '-d', database, ...variables, '-f', PROVISION_SQL_IN_CONTAINER,
    ]);
    if (result.exitCode !== 0) throw new Error(`provision.sql failed:\n${result.output}`);
    return;
  }
  await promisify(execFile)('psql', [withDatabase(adminUrl, database), ...variables, '-f', PROVISION_SQL]);
}

export async function prepareTemplates(adminUrl: string): Promise<void> {
  await provisionDatabase(adminUrl, EMPTY_TEMPLATE_DB);
  await provisionDatabase(adminUrl, TEMPLATE_DB);
  await runMigrations(withCredentials(withDatabase(adminUrl, TEMPLATE_DB), DB_ROLES.owner));
}

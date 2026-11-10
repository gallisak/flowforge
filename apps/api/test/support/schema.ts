import { DataSource } from 'typeorm';
import { entities } from '../../src/app.module';

export const TEMPLATE_DB = 'ff_template';

export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export async function prepareTemplate(url: string): Promise<void> {
  const ds = new DataSource({ type: 'postgres', url, entities, synchronize: true });
  await ds.initialize();
  await ds.destroy();
}

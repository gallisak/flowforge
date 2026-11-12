import { DataSource } from 'typeorm';
import { createTestDatabase, openDataSource, TestDatabase } from './db';
import { closeOpenResources } from './open-resources';

export interface IntegrationContext {
  readonly db: TestDatabase;
  readonly ds: DataSource;
  onTeardown(cleanup: () => Promise<unknown> | unknown): void;
}

export function useIntegrationContext(): IntegrationContext {
  let db: TestDatabase | undefined;
  let ds: DataSource | undefined;
  const teardowns: Array<() => Promise<unknown> | unknown> = [];

  beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
    ds = await openDataSource(db.adminUrl);
  });

  afterAll(async () => {
    await closeOpenResources();
    for (const cleanup of teardowns.reverse()) await cleanup();
    await ds?.destroy();
    await db?.drop();
  });

  return {
    get db() {
      if (!db) throw new Error('Integration context is not initialised yet (use it inside tests or hooks)');
      return db;
    },
    get ds() {
      if (!ds) throw new Error('Integration context is not initialised yet (use it inside tests or hooks)');
      return ds;
    },
    onTeardown(cleanup) {
      teardowns.push(cleanup);
    },
  };
}

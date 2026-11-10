import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

interface PostgresContainerRegistry {
  flowforgeTestPostgres?: StartedPostgreSqlContainer;
}

export const postgresContainerRegistry = globalThis as typeof globalThis & PostgresContainerRegistry;

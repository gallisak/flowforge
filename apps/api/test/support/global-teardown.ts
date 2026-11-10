import { postgresContainerRegistry } from './container';

export default async function globalTeardown(): Promise<void> {
  await postgresContainerRegistry.flowforgeTestPostgres?.stop();
}

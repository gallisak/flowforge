import { INestApplicationContext } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ObservabilityConfig } from '../config/config';
import { createLogger, PinoLoggerService } from './logger';
import { OpsServer, startOpsServer } from './ops-server';

export function useStructuredLogs(app: INestApplicationContext, service: string, config: ObservabilityConfig): PinoLoggerService {
  const logger = new PinoLoggerService(createLogger(service, config.logLevel));
  app.useLogger(logger);
  return logger;
}

export async function startOps(
  app: INestApplicationContext,
  config: ObservabilityConfig,
  componentsReady: () => boolean = () => true,
): Promise<OpsServer> {
  const dataSource = app.get(DataSource);
  const ops = await startOpsServer(config.metricsPort, async () => {
    if (!componentsReady()) return false;
    await dataSource.query('SELECT 1');
    return true;
  });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => ops.markShuttingDown());
  return ops;
}

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

export function runService(service: string, bootstrap: () => Promise<void>): void {
  bootstrap().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ level: 'fatal', time: new Date().toISOString(), service, msg: 'startup failed', error: message })}\n`);
    process.exit(1);
  });
}

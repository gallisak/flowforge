import { NestFactory } from '@nestjs/core';
import { SchedulerModule } from './app.module';
import { loadConfigOrExit, loadSchedulerConfig } from './config/config';
import { startOps, useStructuredLogs } from './observability/bootstrap';
import { SchedulerService } from './scheduler/scheduler.service';

async function bootstrap() {
  const config = loadConfigOrExit(() => loadSchedulerConfig());
  const app = await NestFactory.createApplicationContext(SchedulerModule, { bufferLogs: true });
  const logger = useStructuredLogs(app, 'scheduler', config);
  app.enableShutdownHooks();
  const scheduler = app.get(SchedulerService);
  await startOps(app, config, () => scheduler.isRunning);
  logger.log(`flowforge-scheduler ticking every ${config.schedulerTickMs} ms`, 'Bootstrap');
}
bootstrap();

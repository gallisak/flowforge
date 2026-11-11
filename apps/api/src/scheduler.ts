import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SchedulerModule } from './app.module';
import { loadConfigOrExit, loadSchedulerConfig } from './config/config';

async function bootstrap() {
  const config = loadConfigOrExit(() => loadSchedulerConfig());
  const app = await NestFactory.createApplicationContext(SchedulerModule);
  app.enableShutdownHooks();
  new Logger('Scheduler').log(`flowforge-scheduler ticking every ${config.schedulerTickMs} ms`);
}
bootstrap();

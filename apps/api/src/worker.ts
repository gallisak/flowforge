import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './app.module';
import { loadConfigOrExit, loadWorkerConfig } from './config/config';
import { JobRunnerService } from './engine/job-runner.service';

async function bootstrap() {
  const config = loadConfigOrExit(() => loadWorkerConfig());
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  app.get(JobRunnerService).start(config.workerConcurrency);
}
bootstrap();

import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './app.module';
import { JobRunnerService } from './engine/job-runner.service';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  app.get(JobRunnerService).start();
}
bootstrap();

import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './app.module';
import { loadConfigOrExit, loadWorkerConfig } from './config/config';
import { JobRunnerService } from './engine/job-runner.service';
import { startOps, useStructuredLogs } from './observability/bootstrap';
import { OutboxDispatcher } from './outbox/outbox-dispatcher.service';

async function bootstrap() {
  const config = loadConfigOrExit(() => loadWorkerConfig());
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  useStructuredLogs(app, 'worker', config);
  app.enableShutdownHooks();
  const runner = app.get(JobRunnerService);
  const dispatcher = app.get(OutboxDispatcher);
  runner.start(config.workerConcurrency);
  dispatcher.start();
  await startOps(app, config, () => runner.isRunning && dispatcher.isRunning);
}
bootstrap();

import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DataSource } from 'typeorm';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { ExecutionEventsHub } from './executions/execution-events.hub';
import { loadApiConfig, loadConfigOrExit } from './config/config';
import { runService, startOps, useStructuredLogs } from './observability/bootstrap';
import { registerDatabaseGauges } from './observability/metrics';

async function bootstrap() {
  const config = loadConfigOrExit(() => loadApiConfig());
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, bodyParser: false });
  app.set('trust proxy', config.trustProxy);
  const logger = useStructuredLogs(app, 'api', config);
  configureApp(app);
  app.enableShutdownHooks();
  registerDatabaseGauges(app.get(DataSource), config.metricsTopTenants);
  const hub = app.get(ExecutionEventsHub);
  await startOps(app, config, () => hub.isListening);
  await app.listen(config.port);
  logger.log(`flowforge-api listening on ${config.port}`, 'Bootstrap');
}
runService('api', bootstrap);

import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { loadApiConfig, loadConfigOrExit } from './config/config';
import { startOps, useStructuredLogs } from './observability/bootstrap';
import { registerDatabaseGauges } from './observability/metrics';

async function bootstrap() {
  const config = loadConfigOrExit(() => loadApiConfig());
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = useStructuredLogs(app, 'api', config);
  configureApp(app);
  app.enableShutdownHooks();
  registerDatabaseGauges(app.get(DataSource), config.metricsTopTenants);
  await startOps(app, config);
  await app.listen(config.port);
  logger.log(`flowforge-api listening on ${config.port}`, 'Bootstrap');
}
bootstrap();

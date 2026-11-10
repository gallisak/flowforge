import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { loadApiConfig, loadConfigOrExit } from './config/config';

async function bootstrap() {
  const config = loadConfigOrExit(() => loadApiConfig());
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(config.port);
  console.log(`flowforge-api listening on ${config.port}`);
}
bootstrap();

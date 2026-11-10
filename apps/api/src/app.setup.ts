import { INestApplication, ValidationPipe } from '@nestjs/common';

export function configureApp(app: INestApplication): INestApplication {
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  return app;
}

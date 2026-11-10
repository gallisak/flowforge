import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { rejectNulReviver } from './common/storable';

export function configureApp(app: INestApplication): INestApplication {
  (app as NestExpressApplication).useBodyParser('json', { reviver: rejectNulReviver });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  return app;
}

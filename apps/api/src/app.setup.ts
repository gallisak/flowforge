import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { IncomingMessage } from 'http';
import { jsonTextExceedsDepth, MAX_JSON_DEPTH } from './common/json-depth';
import { rejectNulReviver } from './common/storable';

function rejectDeepJson(_req: IncomingMessage, _res: unknown, body: Buffer): void {
  if (jsonTextExceedsDepth(body.toString('utf8'), MAX_JSON_DEPTH)) {
    throw Object.assign(new Error(`JSON body is nested deeper than ${MAX_JSON_DEPTH} levels`), { status: 400 });
  }
}

export function configureApp(app: INestApplication): INestApplication {
  (app as NestExpressApplication).useBodyParser('json', { reviver: rejectNulReviver, verify: rejectDeepJson });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  return app;
}

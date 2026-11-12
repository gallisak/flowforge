import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { IncomingMessage } from 'http';
import { jsonTextExceedsDepth, MAX_JSON_DEPTH } from './common/json-depth';
import { rejectNulReviver } from './common/storable';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { assignRequestId, enterRequestContext } from './observability/correlation';

export type RawBodyRequest = IncomingMessage & { rawBody?: Buffer };

function keepRawBodyAndRejectDeepJson(req: RawBodyRequest, _res: unknown, body: Buffer): void {
  if (jsonTextExceedsDepth(body.toString('utf8'), MAX_JSON_DEPTH)) {
    throw Object.assign(new Error(`JSON body is nested deeper than ${MAX_JSON_DEPTH} levels`), { status: 400 });
  }
  req.rawBody = body;
}

export function configureApp(app: INestApplication): INestApplication {
  app.use(assignRequestId);
  (app as NestExpressApplication).useBodyParser('json', { inflate: false, reviver: rejectNulReviver, verify: keepRawBodyAndRejectDeepJson });
  app.use(enterRequestContext);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new ApiExceptionFilter());
  return app;
}

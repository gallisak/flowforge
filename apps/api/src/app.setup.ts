import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { IncomingMessage, ServerResponse } from 'http';
import { jsonTextExceedsDepth, MAX_JSON_DEPTH } from './common/json-depth';
import { rejectUnstorableJson } from './common/storable';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { SingleQueryValuesPipe } from './common/single-query-values.pipe';
import { assignRequestId, enterRequestContext } from './observability/correlation';

export type RawBodyRequest = IncomingMessage & { rawBody?: Buffer };

function keepRawBodyAndRejectDeepJson(req: RawBodyRequest, _res: unknown, body: Buffer): void {
  if (jsonTextExceedsDepth(body.toString('utf8'), MAX_JSON_DEPTH)) {
    throw Object.assign(new Error(`JSON body is nested deeper than ${MAX_JSON_DEPTH} levels`), { status: 400 });
  }
  req.rawBody = body;
}

const UNSUPPORTED_BODY = 'Request body must be application/json in UTF-8';

function hasBody(req: IncomingMessage): boolean {
  return req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0;
}

export function isJsonInUtf8(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const [mediaType, ...parameters] = contentType.split(';').map((part) => part.trim().toLowerCase());
  if (mediaType !== 'application/json') return false;
  return parameters.every((parameter) => {
    const [name, value = ''] = parameter.split('=').map((part) => part.trim());
    return name !== 'charset' || ['utf-8', 'utf8', '"utf-8"', '"utf8"'].includes(value);
  });
}

function protectResponses(_req: IncomingMessage, res: ServerResponse, next: () => void): void {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('cache-control', 'no-store');
  next();
}

function acceptOnlyJsonBodies(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  if (!hasBody(req) || isJsonInUtf8(req.headers['content-type'])) return next();
  res.writeHead(415, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ statusCode: 415, message: UNSUPPORTED_BODY, error: 'Unsupported Media Type' }));
}

export function configureApp(app: INestApplication): INestApplication {
  (app as NestExpressApplication).disable('x-powered-by');
  app.use(assignRequestId);
  app.use(protectResponses);
  app.use(acceptOnlyJsonBodies);
  (app as NestExpressApplication).useBodyParser('json', { inflate: false, reviver: rejectUnstorableJson, verify: keepRawBodyAndRejectDeepJson });
  app.use(enterRequestContext);
  app.useGlobalPipes(new SingleQueryValuesPipe(), new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new ApiExceptionFilter());
  return app;
}

import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { metrics } from './metrics';
import { runWithLogContext } from './log-context';

export const REQUEST_ID_HEADER = 'x-request-id';
export const CORRELATION_HEADER = 'X-Correlation-Id';
const VALID_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function correlationIdFrom(header: unknown): string {
  return typeof header === 'string' && VALID_CORRELATION_ID.test(header) ? header : randomUUID();
}

type RequestWithId = Request & { correlationId?: string };

export function assignRequestId(req: RequestWithId, res: Response, next: NextFunction): void {
  req.correlationId = correlationIdFrom(req.headers[REQUEST_ID_HEADER]);
  res.setHeader(REQUEST_ID_HEADER, req.correlationId);
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
    metrics.httpRequestDuration.observe(
      { method: req.method, route, status_code: String(res.statusCode) },
      Number(process.hrtime.bigint() - started) / 1e9,
    );
  });
  next();
}

export function enterRequestContext(req: RequestWithId, _res: Response, next: NextFunction): void {
  runWithLogContext({ correlationId: req.correlationId ?? randomUUID() }, next);
}

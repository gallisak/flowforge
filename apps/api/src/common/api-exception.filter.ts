import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Response } from 'express';
import { STATUS_CODES } from 'http';
import { TooManyRequestsException } from '../limits/too-many-requests';

interface ClientError {
  status?: number;
  expose?: boolean;
  message?: string;
}

function asClientError(exception: unknown): { status: number; message: string } | undefined {
  const candidate = exception as ClientError | null;
  const status = candidate?.status;
  if (!candidate?.expose || typeof status !== 'number' || status < 400 || status > 499) return undefined;
  return { status, message: candidate.message ?? 'Bad request' };
}

const DATABASE_UNAVAILABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', '57014', '57P01', '57P02', '57P03', '53300']);
const DATABASE_UNAVAILABLE_MESSAGES = [/^timeout exceeded when trying to connect/, /^Connection terminated/, /^Query read timeout/];
const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

interface DatabaseError {
  code?: unknown;
  driverError?: { code?: unknown };
}

function isDatabaseUnavailable(error: Error): boolean {
  const { code, driverError } = error as Error & DatabaseError;
  const codes = [code, driverError?.code].filter((value): value is string => typeof value === 'string');
  if (codes.some((value) => DATABASE_UNAVAILABLE_CODES.has(value) || value.startsWith('08'))) return true;
  return DATABASE_UNAVAILABLE_MESSAGES.some((pattern) => pattern.test(error.message));
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      if (exception instanceof TooManyRequestsException) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(exception.retryAfterSeconds))));
      }
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (status >= 500) this.logger.error(exception.message, exception.stack);
      res.status(status).json(typeof body === 'string' ? { statusCode: status, message: body, error: STATUS_CODES[status] } : body);
      return;
    }

    const clientError = asClientError(exception);
    if (clientError) {
      res.status(clientError.status).json({ statusCode: clientError.status, message: clientError.message, error: STATUS_CODES[clientError.status] });
      return;
    }

    const error = exception instanceof Error ? exception : new Error(String(exception));
    if (isDatabaseUnavailable(error)) {
      this.logger.error(`database unavailable: ${error.message}`);
      res.setHeader('Retry-After', String(UNAVAILABLE_RETRY_AFTER_SECONDS));
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        message: 'The service is temporarily unavailable, try again later',
        error: STATUS_CODES[HttpStatus.SERVICE_UNAVAILABLE],
      });
      return;
    }
    this.logger.error(`unhandled error: ${error.message}`, error.stack);
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      error: STATUS_CODES[HttpStatus.INTERNAL_SERVER_ERROR],
    });
  }
}

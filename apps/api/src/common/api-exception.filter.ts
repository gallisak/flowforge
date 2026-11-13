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
    this.logger.error(`unhandled error: ${error.message}`, error.stack);
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      error: STATUS_CODES[HttpStatus.INTERNAL_SERVER_ERROR],
    });
  }
}

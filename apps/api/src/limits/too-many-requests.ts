import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';

export class TooManyRequestsException extends HttpException {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super({ statusCode: HttpStatus.TOO_MANY_REQUESTS, message, error: 'Too Many Requests' }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

@Catch(TooManyRequestsException)
export class TooManyRequestsFilter implements ExceptionFilter {
  catch(exception: TooManyRequestsException, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(exception.retryAfterSeconds))));
    res.status(exception.getStatus()).json(exception.getResponse());
  }
}

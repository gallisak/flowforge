import { LoggerService } from '@nestjs/common';
import pino, { DestinationStream, Level, Logger } from 'pino';
import { currentLogContext } from './log-context';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevelName = (typeof LOG_LEVELS)[number];

const REDACTED_PATHS = [
  'headers["x-api-key"]',
  'headers["x-admin-token"]',
  'headers.authorization',
  'headers.cookie',
  'headers["webhook-signature"]',
  '*.secret',
  '*.apiKey',
];

export function createLogger(service: string, level: LogLevelName, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
      mixin: () => ({ ...currentLogContext() }),
    },
    destination,
  );
}

export class PinoLoggerService implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.write('info', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.write('trace', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.write('fatal', message, params);
  }

  private write(level: Level, message: unknown, params: unknown[]): void {
    const context = typeof params[params.length - 1] === 'string' ? (params[params.length - 1] as string) : undefined;
    const stack = level === 'error' && params.length > 1 && typeof params[0] === 'string' ? params[0] : undefined;
    if (message instanceof Error) {
      this.logger[level]({ context, err: message }, message.message);
    } else if (typeof message === 'object' && message !== null) {
      this.logger[level]({ context, ...message });
    } else {
      this.logger[level]({ context, stack }, String(message));
    }
  }
}

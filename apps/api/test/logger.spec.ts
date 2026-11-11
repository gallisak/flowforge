import { Writable } from 'stream';
import { correlationIdFrom } from '../src/observability/correlation';
import { runWithLogContext } from '../src/observability/log-context';
import { createLogger, PinoLoggerService } from '../src/observability/logger';

function capture(): { lines: () => Array<Record<string, unknown>>; logger: PinoLoggerService } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  const logger = new PinoLoggerService(createLogger('test', 'debug', stream));
  return {
    logger,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}

describe('structured logs', () => {
  it('adds the fields of the current log context to every line', () => {
    const { logger, lines } = capture();

    runWithLogContext({ correlationId: 'trace-1', executionId: 'e-1', stepId: 'call' }, () => logger.log('step started', 'StepExecutor'));

    expect(lines()).toEqual([
      expect.objectContaining({
        level: 30,
        service: 'test',
        context: 'StepExecutor',
        msg: 'step started',
        correlationId: 'trace-1',
        executionId: 'e-1',
        stepId: 'call',
      }),
    ]);
  });

  it('keeps the stack of an error', () => {
    const { logger, lines } = capture();

    logger.error('unhandled error: boom', 'Error: boom\n    at here', 'ApiExceptionFilter');

    expect(lines()[0]).toMatchObject({ level: 50, msg: 'unhandled error: boom', stack: 'Error: boom\n    at here', context: 'ApiExceptionFilter' });
  });

  it('redacts credentials in structured log fields', () => {
    const { logger, lines } = capture();

    logger.log({ msg: 'request', headers: { 'x-api-key': 'ff_secret', authorization: 'Bearer t', accept: 'json' }, hook: { secret: 'whsec_x' } });

    const line = JSON.stringify(lines()[0]);
    expect(line).not.toContain('ff_secret');
    expect(line).not.toContain('Bearer t');
    expect(line).not.toContain('whsec_x');
    expect(lines()[0]).toMatchObject({ headers: { accept: 'json' } });
  });
});

describe('correlationIdFrom', () => {
  it('keeps a well-formed incoming id', () => {
    expect(correlationIdFrom('req-1:abc.DEF_9')).toBe('req-1:abc.DEF_9');
  });

  it.each([undefined, '', 'has space', 'x'.repeat(129), ['a', 'b'], 'line\nbreak'])('generates a new id instead of %j', (header) => {
    expect(correlationIdFrom(header)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

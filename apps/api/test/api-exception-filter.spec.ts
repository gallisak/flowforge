import { ArgumentsHost, BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { ApiExceptionFilter } from '../src/common/api-exception.filter';
import { TooManyRequestsException } from '../src/limits/too-many-requests';

function respond(exception: unknown) {
  const response = { statusCode: 0, body: undefined as unknown, headers: {} as Record<string, string> };
  const res = {
    setHeader: (name: string, value: string) => {
      response.headers[name] = value;
    },
    status(code: number) {
      response.statusCode = code;
      return this;
    },
    json(body: unknown) {
      response.body = body;
      return this;
    },
  };
  const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
  new ApiExceptionFilter().catch(exception, host);
  return response;
}

describe('ApiExceptionFilter', () => {
  let logged: jest.SpyInstance;

  beforeEach(() => {
    logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => logged.mockRestore());

  it('passes HTTP errors through unchanged', () => {
    expect(respond(new NotFoundException('Workflow not found'))).toMatchObject({
      statusCode: 404,
      body: { statusCode: 404, message: 'Workflow not found', error: 'Not Found' },
    });
    expect(respond(new BadRequestException(['name must be a string'])).body).toMatchObject({ message: ['name must be a string'] });
  });

  it('adds Retry-After to a rate limit error', () => {
    const response = respond(new TooManyRequestsException('Rate limit exceeded', 12.2));

    expect(response.statusCode).toBe(429);
    expect(response.headers['Retry-After']).toBe('13');
  });

  it('keeps the status of a client error raised before routing, such as a body parser error', () => {
    const parseError = Object.assign(new Error('Unexpected end of JSON input'), { status: 400, expose: true });

    expect(respond(parseError)).toEqual({ statusCode: 400, body: { statusCode: 400, message: 'Unexpected end of JSON input' }, headers: {} });
  });

  it('hides the details of an unexpected error and logs them instead', () => {
    const failure = Object.assign(new Error('relation "secrets" does not exist'), { query: 'SELECT secret FROM secrets' });

    const response = respond(failure);

    expect(response).toEqual({ statusCode: 500, body: { statusCode: 500, message: 'Internal server error' }, headers: {} });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('relation "secrets" does not exist'), expect.any(String));
  });

  it('does not expose a server error that marks itself as exposable', () => {
    const response = respond(Object.assign(new Error('pool exhausted'), { status: 503, expose: true }));

    expect(response.statusCode).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('pool exhausted');
  });
});

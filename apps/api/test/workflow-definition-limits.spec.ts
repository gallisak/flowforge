import { BadRequestException } from '@nestjs/common';
import { HTTP_METHODS, STEP_LIMITS, validateSteps } from '../src/workflows/definition';

const http = (extra: Record<string, unknown>) => [{ id: 'call', type: 'http', url: 'https://example.com', ...extra }];

describe('validateSteps limits', () => {
  it.each(HTTP_METHODS)('accepts the %s method', (method) => {
    expect(validateSteps(http({ method }))).toHaveLength(1);
  });

  it.each(['TRACE', 'CONNECT', 'get', 1])('rejects the %p method', (method) => {
    expect(() => validateSteps(http({ method }))).toThrow(BadRequestException);
  });

  it('accepts headers with string values', () => {
    expect(validateSteps(http({ headers: { authorization: 'Bearer token', 'x-request-source': 'flowforge' } }))).toHaveLength(1);
  });

  it.each([
    ['a non-object', 'authorization: x'],
    ['a non-string value', { 'x-count': 1 }],
    ['a value with a line break', { 'x-injected': 'a\r\nx-other: b' }],
    ['an invalid header name', { 'bad header': 'x' }],
    ['a forbidden host header', { Host: 'internal.service' }],
    ['a forbidden content-length header', { 'content-length': '1' }],
    ['too many headers', Object.fromEntries(Array.from({ length: STEP_LIMITS.headers + 1 }, (_, i) => [`x-h${i}`, 'v']))],
    ['a value that is too long', { 'x-long': 'v'.repeat(STEP_LIMITS.headerValueLength + 1) }],
  ])('rejects headers with %s', (_case, headers) => {
    expect(() => validateSteps(http({ headers }))).toThrow(BadRequestException);
  });

  it('accepts a body at the size limit and rejects one byte more', () => {
    expect(validateSteps(http({ method: 'POST', body: 'x'.repeat(STEP_LIMITS.bodyLength) }))).toHaveLength(1);
    expect(() => validateSteps(http({ method: 'POST', body: 'x'.repeat(STEP_LIMITS.bodyLength + 1) }))).toThrow(
      BadRequestException,
    );
  });

  it('rejects a non-string body', () => {
    expect(() => validateSteps(http({ method: 'POST', body: { a: 1 } }))).toThrow(BadRequestException);
  });

  it('rejects a url longer than the limit', () => {
    expect(() => validateSteps([{ id: 'call', type: 'http', url: `https://example.com/${'a'.repeat(STEP_LIMITS.urlLength)}` }])).toThrow(
      BadRequestException,
    );
  });

  it('accepts a transform expression at the size limit and rejects a longer one', () => {
    expect(validateSteps([{ id: 'shape', type: 'transform', expr: '1'.repeat(STEP_LIMITS.exprLength) }])).toHaveLength(1);
    expect(() => validateSteps([{ id: 'shape', type: 'transform', expr: '1'.repeat(STEP_LIMITS.exprLength + 1) }])).toThrow(
      BadRequestException,
    );
  });

  it('accepts a log message at the size limit and rejects a longer one', () => {
    expect(validateSteps([{ id: 'note', type: 'log', message: 'x'.repeat(STEP_LIMITS.messageLength) }])).toHaveLength(1);
    expect(() => validateSteps([{ id: 'note', type: 'log', message: 'x'.repeat(STEP_LIMITS.messageLength + 1) }])).toThrow(
      BadRequestException,
    );
  });

  it('rejects more steps than the limit', () => {
    const steps = Array.from({ length: STEP_LIMITS.steps + 1 }, (_, i) => ({ id: `s${i}`, type: 'log', message: 'x' }));
    expect(() => validateSteps(steps)).toThrow(BadRequestException);
  });

  it('rejects an array in place of a step', () => {
    expect(() => validateSteps([['not', 'a', 'step']])).toThrow(BadRequestException);
  });
});

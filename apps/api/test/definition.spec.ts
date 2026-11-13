import { BadRequestException } from '@nestjs/common';
import { validateSteps } from '../src/workflows/definition';

describe('validateSteps', () => {
  it('accepts a valid definition', () => {
    const steps = validateSteps([
      { id: 'fetch', type: 'http', url: 'https://example.com' },
      { id: 'shape', type: 'transform', expr: 'ctx.steps.fetch.body' },
    ]);
    expect(steps).toHaveLength(2);
  });

  it('rejects an empty list', () => {
    expect(() => validateSteps([])).toThrow(BadRequestException);
  });

  it('rejects duplicate step ids', () => {
    expect(() =>
      validateSteps([
        { id: 'a', type: 'log', message: 'x' },
        { id: 'a', type: 'log', message: 'y' },
      ]),
    ).toThrow(BadRequestException);
  });

  it('rejects an unknown step type', () => {
    expect(() => validateSteps([{ id: 'a', type: 'shell', cmd: 'ls' }])).toThrow(BadRequestException);
  });

  it('rejects a negative delay', () => {
    expect(() => validateSteps([{ id: 'a', type: 'delay', ms: -1 }])).toThrow(BadRequestException);
  });
  it.each([
    [{ id: 'a', type: 'http', url: 'https://example.com', header: { accept: 'text/plain' } }, 'steps[0].header is not a field of http steps'],
    [{ id: 'a', type: 'log', message: 'x', expr: '1' }, 'steps[0].expr is not a field of log steps'],
    [{ id: 'a', type: 'delay', ms: 5, seconds: 5 }, 'steps[0].seconds is not a field of delay steps'],
  ])('rejects a field the step type does not have: %o', (step, message) => {
    expect(() => validateSteps([step])).toThrow(message);
  });
});

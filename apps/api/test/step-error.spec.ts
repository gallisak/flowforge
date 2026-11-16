import { STEP_ERROR_MAX_CHARS, StepError } from '../src/engine/step-executor';

describe('StepError', () => {
  it('keeps the stored error text bounded however long the cause is', () => {
    expect(new StepError('x'.repeat(5_000_000)).message.length).toBeLessThanOrEqual(STEP_ERROR_MAX_CHARS);
  });

  it('keeps short messages as they are', () => {
    expect(new StepError('http 503').message).toBe('http 503');
  });
});

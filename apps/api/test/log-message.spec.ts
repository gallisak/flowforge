import { LOG_MESSAGE_MAX_LENGTH, sanitizeLogMessage } from '../src/engine/step-executor';

describe('sanitizeLogMessage', () => {
  it('keeps a short single-line message unchanged', () => {
    expect(sanitizeLogMessage('order 42 shipped')).toBe('order 42 shipped');
  });

  it('escapes line breaks so a message cannot forge extra log lines', () => {
    expect(sanitizeLogMessage('ok\r\n[Nest] ERROR forged entry')).toBe('ok\\r\\n[Nest] ERROR forged entry');
  });

  it('truncates long messages', () => {
    const message = sanitizeLogMessage('x'.repeat(LOG_MESSAGE_MAX_LENGTH * 10));
    expect(message).toBe(`${'x'.repeat(LOG_MESSAGE_MAX_LENGTH)}...`);
  });
});

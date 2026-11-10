import { rejectNulReviver, storableText, toStorable } from '../src/common/storable';

describe('storable values', () => {
  it('replaces NUL characters in text', () => {
    expect(storableText('a\u0000b\u0000')).toBe('a\uFFFDb\uFFFD');
  });

  it('replaces NUL characters in nested strings and keys and keeps other values', () => {
    expect(toStorable({ 'k\u0000': ['x\u0000', 1, true, null, { deep: 'y\u0000' }] })).toEqual({
      'k\uFFFD': ['x\uFFFD', 1, true, null, { deep: 'y\uFFFD' }],
    });
  });

  it('keeps an escaped backslash followed by u0000 as written', () => {
    expect(toStorable('\\u0000')).toBe('\\u0000');
  });

  it('rejects JSON with a NUL character in a value or a key', () => {
    expect(() => JSON.parse('{"a":"x\\u0000"}', rejectNulReviver)).toThrow(SyntaxError);
    expect(() => JSON.parse('{"\\u0000":1}', rejectNulReviver)).toThrow(SyntaxError);
    expect(JSON.parse('{"a":"\\\\u0000"}', rejectNulReviver)).toEqual({ a: '\\u0000' });
  });
});

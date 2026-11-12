import { rejectUnstorableJson, storableText, toStorable, truncatedText } from '../src/common/storable';

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
    expect(() => JSON.parse('{"a":"x\\u0000"}', rejectUnstorableJson)).toThrow(SyntaxError);
    expect(() => JSON.parse('{"\\u0000":1}', rejectUnstorableJson)).toThrow(SyntaxError);
    expect(JSON.parse('{"a":"\\\\u0000"}', rejectUnstorableJson)).toEqual({ a: '\\u0000' });
  });

  it('replaces lone surrogates in nested strings and keys and keeps valid pairs', () => {
    expect(toStorable({ 'k\uD800': ['x\uDFFF', 'ok 😀'] })).toEqual({ 'k�': ['x�', 'ok 😀'] });
  });

  it('rejects JSON with a lone surrogate in a value or a key', () => {
    expect(() => JSON.parse('{"a":"x\\ud800"}', rejectUnstorableJson)).toThrow(SyntaxError);
    expect(() => JSON.parse('{"\\udfff":1}', rejectUnstorableJson)).toThrow(SyntaxError);
    expect(JSON.parse('{"a":"\\ud83d\\ude00"}', rejectUnstorableJson)).toEqual({ a: '😀' });
  });

  it('rejects JSON numbers outside the double range', () => {
    expect(() => JSON.parse('{"a":1e400}', rejectUnstorableJson)).toThrow(SyntaxError);
    expect(() => JSON.parse('[-1e400]', rejectUnstorableJson)).toThrow(SyntaxError);
    expect(JSON.parse('{"a":1.5e300}', rejectUnstorableJson)).toEqual({ a: 1.5e300 });
  });

  it('cuts text on a code point boundary', () => {
    expect(truncatedText('ab😀c', 3)).toBe('ab');
    expect(truncatedText('ab😀c', 4)).toBe('ab😀');
    expect(truncatedText('abc', 10)).toBe('abc');
  });
});

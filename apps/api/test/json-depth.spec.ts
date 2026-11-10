import { jsonTextExceedsDepth, valueExceedsDepth } from '../src/common/json-depth';

const nestedText = (depth: number) => `${'['.repeat(depth)}${']'.repeat(depth)}`;

describe('jsonTextExceedsDepth', () => {
  it('counts arrays and objects', () => {
    expect(jsonTextExceedsDepth('{"a":[{"b":[]}]}', 4)).toBe(false);
    expect(jsonTextExceedsDepth('{"a":[{"b":[]}]}', 3)).toBe(true);
  });

  it('ignores brackets inside strings, including escaped quotes', () => {
    expect(jsonTextExceedsDepth('{"a":"[[[[\\"[[[[{{{{"}', 1)).toBe(false);
  });

  it('handles text far deeper than the call stack', () => {
    expect(jsonTextExceedsDepth(nestedText(1_000_000), 64)).toBe(true);
  });

  it('accepts scalars', () => {
    expect(jsonTextExceedsDepth('"text"', 0)).toBe(false);
  });
});

describe('valueExceedsDepth', () => {
  it('measures nesting of arrays and objects', () => {
    expect(valueExceedsDepth({ a: [{ b: [] }] }, 4)).toBe(false);
    expect(valueExceedsDepth({ a: [{ b: [] }] }, 3)).toBe(true);
    expect(valueExceedsDepth('scalar', 0)).toBe(false);
  });

  it('handles values far deeper than the call stack', () => {
    expect(valueExceedsDepth(JSON.parse(nestedText(200_000)), 64)).toBe(true);
  });
});

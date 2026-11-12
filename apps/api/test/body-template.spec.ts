import { bodyFormatOf, renderBodyTemplate, StepContext } from '../src/engine/template';

const ctx = (input: Record<string, unknown>): StepContext => ({ input, steps: { fetch: { body: { id: 7 } } } });

describe('bodyFormatOf', () => {
  it.each([
    ['{"a":1}', {}, 'json'],
    ['  [1]', {}, 'json'],
    ['plain text', {}, 'text'],
    ['a=1', { 'Content-Type': 'application/json; charset=utf-8' }, 'json'],
    ['a=1', { 'content-type': 'application/vnd.api+json' }, 'json'],
    ['{"a":1}', { 'content-type': 'application/x-www-form-urlencoded' }, 'form'],
    ['{"a":1}', { 'content-type': 'text/plain' }, 'json'],
    ['{"a":1}', { 'content-type': 'application/jsonp' }, 'json'],
  ])('treats %j with headers %j as %s', (template, headers, expected) => {
    expect(bodyFormatOf(template, headers as Record<string, string>)).toBe(expected);
  });
});

describe('renderBodyTemplate as JSON', () => {
  const render = (template: string, input: Record<string, unknown>) => JSON.parse(renderBodyTemplate(template, ctx(input), 'json'));

  it('escapes quotes, backslashes and control characters inside strings', () => {
    expect(render('{"v":"<{{ input.v }}>"}', { v: 'a"b\\c\nd e' })).toEqual({ v: '<a"b\\c\nd e>' });
  });

  it('inserts JSON values outside strings', () => {
    expect(render('[{{ input.n }},{{ input.b }},{{ input.o }},{{ input.s }},{{ input.missing }}]', { n: 1.5, b: false, o: { k: [1] }, s: 'x' })).toEqual([
      1.5,
      false,
      { k: [1] },
      'x',
      null,
    ]);
  });

  it('serializes an object placed inside a string', () => {
    expect(render('{"v":"{{ steps.fetch.body }}"}', {})).toEqual({ v: '{"id":7}' });
  });

  it('follows escaped quotes in the literal parts of the template', () => {
    expect(render('{"v":"say \\"{{ input.v }}\\" now","w":{{ input.w }}}', { v: '"', w: 2 })).toEqual({ v: 'say """ now', w: 2 });
  });

  it('renders an empty string for a missing value inside a string', () => {
    expect(render('{"v":"[{{ input.missing }}]"}', {})).toEqual({ v: '[]' });
  });
});

describe('renderBodyTemplate for other formats', () => {
  it('url-encodes values of a form body', () => {
    expect(renderBodyTemplate('a={{ input.v }}&b=2', ctx({ v: 'x&b=3 y' }), 'form')).toBe('a=x%26b%3D3%20y&b=2');
  });

  it('inserts values of a text body as they are', () => {
    expect(renderBodyTemplate('hello {{ input.v }}', ctx({ v: '"world"' }), 'text')).toBe('hello "world"');
  });
});

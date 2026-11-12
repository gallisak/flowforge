import { BadRequestException } from '@nestjs/common';
import { bodyFormatOf, BodyTemplateError, renderBodyTemplate, renderUrlTemplate, UrlTemplateError } from '../src/engine/template';
import { validateSteps } from '../src/workflows/definition';

describe('values that try to escape their place in a template', () => {
  const ctx = (input: Record<string, unknown>) => ({ input, steps: {} });

  it.each(['..', '.'])('refuses a url path segment that a value turns into %s', (value) => {
    expect(() => renderUrlTemplate('https://billing.partner.com/customers/{{input.id}}/invoices', ctx({ id: value }))).toThrow(UrlTemplateError);
  });

  it.each(['/customers/.{{input.id}}/invoices', '/customers/%2E{{input.id}}/invoices', '/customers/{{input.id}}'])(
    'refuses a dot segment that a value completes in %s',
    (path) => {
      expect(() => renderUrlTemplate(`https://billing.partner.com${path}`, ctx({ id: '.' }))).toThrow(UrlTemplateError);
    },
  );

  it('keeps an encoded percent sign that only looks like a dot', () => {
    expect(renderUrlTemplate('https://api.example.com/files/{{input.name}}', ctx({ name: '%2e%2e' }))).toBe('https://api.example.com/files/%252e%252e');
  });

  it('keeps values with dots that are not whole path segments', () => {
    expect(renderUrlTemplate('https://api.example.com/files/{{input.name}}?q={{input.q}}', ctx({ name: 'report.v2..pdf', q: '..' }))).toBe(
      'https://api.example.com/files/report.v2..pdf?q=..',
    );
  });

  it.each(['text/json', 'application/x-json', 'text/x-json; charset=utf-8', 'text/plain'])(
    'escapes a value in a JSON-looking body sent as %s',
    (contentType) => {
      const template = '{"name":"{{input.name}}"}';
      const body = renderBodyTemplate(template, ctx({ name: 'x","role":"admin' }), bodyFormatOf(template, { 'Content-Type': contentType }));

      expect(JSON.parse(body)).toEqual({ name: 'x","role":"admin' });
    },
  );

  it('keeps a text body that does not look like JSON unescaped', () => {
    const template = 'hello {{input.name}}';

    expect(bodyFormatOf(template, { 'content-type': 'text/plain' })).toBe('text');
  });
});

describe('dot segments next to an explicit port', () => {
  it('finds a dot segment after an origin with a default port', () => {
    expect(() => renderUrlTemplate('https://billing.partner.com:443/customers/{{input.id}}/x', { input: { id: '..' }, steps: {} })).toThrow(UrlTemplateError);
  });
});

describe('backslashes next to placeholders', () => {
  const ctx = (input: Record<string, unknown>) => ({ input, steps: {} });
  const httpStep = (fields: Record<string, unknown>) => [{ id: 'call', type: 'http', url: 'https://api.example.com/', ...fields }];

  it('refuses a JSON body whose string escape is completed by a value', () => {
    expect(() => renderBodyTemplate('{"a":"\\{{input.x}}"}', ctx({ x: 'nice' }), 'json')).toThrow(BodyTemplateError);
  });

  it('keeps an escaped backslash before a value', () => {
    expect(JSON.parse(renderBodyTemplate('{"a":"\\\\{{input.x}}"}', ctx({ x: 'n' }), 'json'))).toEqual({ a: '\\n' });
  });

  it('rejects a JSON body template with an unfinished escape before a placeholder', () => {
    expect(() => validateSteps(httpStep({ body: '{"a":"\\{{input.x}}"}' }))).toThrow(BadRequestException);
    expect(() => validateSteps(httpStep({ body: 'a=\\{{input.x}}', headers: { 'content-type': 'application/x-www-form-urlencoded' } }))).not.toThrow();
  });

  it('refuses a url whose backslashes a value turns into a dot segment', () => {
    expect(() => renderUrlTemplate('https://api.example.com/users\\{{input.p}}\\admin', ctx({ p: '..' }))).toThrow(UrlTemplateError);
  });

  it.each(['https://api.example.com/users\\{{input.p}}', 'https://api.example.com/a\\b'])('rejects a url template with a backslash: %s', (url) => {
    expect(() => validateSteps(httpStep({ url }))).toThrow(/url must not contain a backslash/);
  });
});

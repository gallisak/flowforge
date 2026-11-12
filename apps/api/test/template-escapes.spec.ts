import { bodyFormatOf, renderBodyTemplate, renderUrlTemplate, UrlTemplateError } from '../src/engine/template';

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

import { fixedOriginOf, renderTemplate, renderUrlTemplate, UrlTemplateError } from '../src/engine/template';
import { validateSteps } from '../src/workflows/definition';

const ctx = {
  input: { id: 'a/b?c#d', items: ['first', 'second'], name: 'Ada Lovelace', constructor: 'own value' },
  steps: { fetch: { status: 200, body: { token: 'x' } } },
};

describe('renderTemplate property lookup', () => {
  it.each(['input.__proto__', 'input.toString', 'input.hasOwnProperty', 'steps.fetch.constructor.name', 'input.items.map'])(
    'renders the inherited member %s as an empty string',
    (path) => {
      expect(renderTemplate(`[{{ ${path} }}]`, ctx)).toBe('[]');
    },
  );

  it('does not resolve names reserved for prototypes even as own keys', () => {
    expect(renderTemplate('[{{ input.constructor }}]', ctx)).toBe('[]');
  });

  it('resolves array elements and own array properties', () => {
    expect(renderTemplate('{{ input.items.1 }} of {{ input.items.length }}', ctx)).toBe('second of 2');
  });
});

describe('fixedOriginOf', () => {
  it.each([
    ['https://api.example.com', 'https://api.example.com'],
    ['https://api.example.com/items/{{ input.id }}', 'https://api.example.com'],
    ['http://API.example.com:8080?q={{ input.q }}', 'http://api.example.com:8080'],
    ['https://api.example.com#{{ input.anchor }}', 'https://api.example.com'],
  ])('finds the origin of %s', (template, origin) => {
    expect(fixedOriginOf(template)).toBe(origin);
  });

  it.each([
    'https://api.example.com{{ input.path }}',
    'https://{{ input.subdomain }}.example.com/',
    'https://api.example.com:{{ input.port }}/',
    'https://user@{{ input.host }}/',
    'https://api.example.com\\{{ input.path }}',
    '{{ input.url }}',
    'ftp://files.example.com/{{ input.name }}',
    'not a url',
  ])('finds no fixed origin in %s', (template) => {
    expect(fixedOriginOf(template)).toBeUndefined();
  });
});

describe('renderUrlTemplate', () => {
  it('encodes every value as a single url component', () => {
    expect(renderUrlTemplate('https://api.example.com/users/{{ input.id }}?name={{ input.name }}', ctx)).toBe(
      'https://api.example.com/users/a%2Fb%3Fc%23d?name=Ada%20Lovelace',
    );
  });

  it('encodes objects as JSON', () => {
    expect(renderUrlTemplate('https://api.example.com/?body={{ steps.fetch.body }}', ctx)).toBe(
      'https://api.example.com/?body=%7B%22token%22%3A%22x%22%7D',
    );
  });

  it('leaves a url without placeholders untouched', () => {
    expect(renderUrlTemplate('https://api.example.com/a b', ctx)).toBe('https://api.example.com/a b');
  });

  it('refuses a stored template whose origin depends on input', () => {
    expect(() => renderUrlTemplate('https://api.example.com{{ input.id }}', ctx)).toThrow(UrlTemplateError);
    expect(() => renderUrlTemplate('{{ input.id }}', ctx)).toThrow(UrlTemplateError);
  });
});

describe('http step url validation', () => {
  const step = (url: string) => [{ id: 'call', type: 'http', url }];

  it('accepts placeholders after a fixed origin', () => {
    expect(() => validateSteps(step('https://api.example.com/users/{{ input.id }}?q={{ input.q }}'))).not.toThrow();
  });

  it.each(['https://api.example.com{{ input.path }}', '{{ input.url }}', 'file:///etc/passwd', 'example.com/path'])(
    'rejects %s',
    (url) => {
      expect(() => validateSteps(step(url))).toThrow(/url must start with a fixed http or https origin/);
    },
  );
});

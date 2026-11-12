import {
  renderBodyTemplate,
  renderLogMessage,
  renderUrlTemplate,
  RENDERED_LIMITS,
  StepContext,
  TemplateTooLargeError,
} from '../src/engine/template';

const MB = 1024 * 1024;
const ctx: StepContext = { input: {}, steps: { big: 'x'.repeat(MB), small: 'y'.repeat(100) } };
const repeated = (placeholder: string, times: number) => Array.from({ length: times }, () => placeholder).join(',');

describe('rendered template limits', () => {
  it('refuses an http url that grows beyond its limit after rendering', () => {
    expect(() => renderUrlTemplate(`https://api.example.com/?q=${repeated('{{ steps.big }}', 184)}`, ctx)).toThrow(TemplateTooLargeError);
    expect(() => renderUrlTemplate(`https://api.example.com/?q=${repeated('{{ steps.small }}', 100)}`, ctx)).toThrow(
      `http url exceeds ${RENDERED_LIMITS.url} characters after rendering`,
    );
  });

  it('accepts an http url that stays within its limit', () => {
    expect(renderUrlTemplate(`https://api.example.com/?q={{ steps.small }}`, ctx)).toHaveLength(127);
  });

  it.each(['json', 'form', 'text'] as const)('refuses a %s body that grows beyond its limit after rendering', (format) => {
    const template = format === 'json' ? `[${repeated('"{{ steps.big }}"', 3_000)}]` : repeated('{{ steps.big }}', 3_000);
    const started = Date.now();
    expect(() => renderBodyTemplate(template, ctx, format)).toThrow(`http body exceeds ${RENDERED_LIMITS.body} characters after rendering`);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('cuts a log message at its limit while rendering', () => {
    const rendered = renderLogMessage(repeated('{{ steps.big }}', 186), ctx);
    expect(rendered.text).toHaveLength(RENDERED_LIMITS.log);
    expect(rendered.truncated).toBe(true);
    expect(renderLogMessage('hello {{ steps.small }}', ctx)).toEqual({ text: `hello ${'y'.repeat(100)}`, truncated: false });
  });
});

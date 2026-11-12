export interface StepContext {
  input: Record<string, unknown>;
  steps: Record<string, unknown>;
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
const FIXED_ORIGIN = /^(https?:\/\/[^/?#{}\s]+)[/?#]/i;
const INHERITED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

export class UrlTemplateError extends Error {}

function lookup(ctx: StepContext, path: string): unknown {
  let cur: unknown = ctx;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (INHERITED_NAMES.has(key) || !Object.hasOwn(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export class TemplateTooLargeError extends Error {}

export const RENDERED_LIMITS = {
  url: 8 * 1024,
  log: 2 * 1024,
  body: 1024 * 1024,
} as const;

export interface RenderLimit {
  maxLength: number;
  what: string;
  overflow?: 'throw' | 'truncate';
}

class BoundedText {
  private text = '';
  truncated = false;

  constructor(private readonly limit?: RenderLimit) {}

  append(piece: string): boolean {
    if (!this.limit || this.text.length + piece.length <= this.limit.maxLength) {
      this.text += piece;
      return true;
    }
    if (this.limit.overflow === 'truncate') {
      this.text += piece.slice(0, this.limit.maxLength - this.text.length);
      this.truncated = true;
      return false;
    }
    throw new TemplateTooLargeError(`${this.limit.what} exceeds ${this.limit.maxLength} characters after rendering`);
  }

  toString(): string {
    return this.text;
  }
}

function renderWith(template: string, limit: RenderLimit | undefined, placeholder: (path: string, before: string) => string): BoundedText {
  const out = new BoundedText(limit);
  let last = 0;
  for (const match of template.matchAll(new RegExp(PLACEHOLDER.source, 'g'))) {
    const literal = template.slice(last, match.index);
    if (!out.append(literal) || !out.append(placeholder(match[1], literal))) return out;
    last = match.index + match[0].length;
  }
  out.append(template.slice(last));
  return out;
}

export function renderTemplate(
  template: string,
  ctx: StepContext,
  encode: (value: string) => string = (value) => value,
  limit?: RenderLimit,
): string {
  return renderWith(template, limit, (path) => {
    const value = lookup(ctx, path);
    if (value === undefined || value === null) return '';
    return encode(textOf(value));
  }).toString();
}

export function renderLogMessage(template: string, ctx: StepContext, maxLength: number = RENDERED_LIMITS.log): { text: string; truncated: boolean } {
  const out = renderWith(template, { maxLength, what: 'log message', overflow: 'truncate' }, (path) => textOf(lookup(ctx, path)));
  return { text: out.toString(), truncated: out.truncated };
}

export type BodyFormat = 'json' | 'form' | 'text';

const JSON_MEDIA_TYPE = /^application\/([a-z0-9.!#$&^_-]+\+)?json\s*(;|$)/;
const FORM_MEDIA_TYPE = /^application\/x-www-form-urlencoded\s*(;|$)/;

export function bodyFormatOf(template: string, headers: Record<string, string> = {}): BodyFormat {
  const contentType = Object.entries(headers)
    .find(([name]) => name.toLowerCase() === 'content-type')?.[1]
    ?.trim()
    .toLowerCase();
  if (contentType === undefined) return /^\s*[[{]/.test(template) ? 'json' : 'text';
  if (JSON_MEDIA_TYPE.test(contentType)) return 'json';
  if (FORM_MEDIA_TYPE.test(contentType)) return 'form';
  return 'text';
}

function textOf(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function renderJsonTemplate(template: string, ctx: StepContext, limit: RenderLimit): string {
  let inString = false;
  let escaped = false;
  return renderWith(template, limit, (path, literal) => {
    for (const char of literal) {
      if (escaped) escaped = false;
      else if (inString && char === '\\') escaped = true;
      else if (char === '"') inString = !inString;
    }
    escaped = false;
    const value = lookup(ctx, path);
    return inString ? JSON.stringify(textOf(value)).slice(1, -1) : JSON.stringify(value ?? null);
  }).toString();
}

export function renderBodyTemplate(template: string, ctx: StepContext, format: BodyFormat, maxLength: number = RENDERED_LIMITS.body): string {
  const limit = { maxLength, what: 'http body' };
  if (format === 'json') return renderJsonTemplate(template, ctx, limit);
  if (format === 'form') return renderTemplate(template, ctx, encodeURIComponent, limit);
  return renderTemplate(template, ctx, undefined, limit);
}

export function hasPlaceholders(template: string): boolean {
  return new RegExp(PLACEHOLDER.source).test(template);
}

export function fixedOriginOf(template: string): string | undefined {
  const firstPlaceholder = template.search(new RegExp(PLACEHOLDER.source));
  const literal = firstPlaceholder === -1 ? template : template.slice(0, firstPlaceholder);
  const match = FIXED_ORIGIN.exec(firstPlaceholder === -1 ? `${literal}/` : literal);
  if (!match) return undefined;
  try {
    return new URL(match[1]).origin;
  } catch {
    return undefined;
  }
}

export function renderUrlTemplate(template: string, ctx: StepContext): string {
  if (!hasPlaceholders(template)) return template;
  const origin = fixedOriginOf(template);
  if (!origin) throw new UrlTemplateError('http url template must start with a fixed origin');
  const rendered = renderTemplate(template, ctx, encodeURIComponent, { maxLength: RENDERED_LIMITS.url, what: 'http url' });
  let renderedOrigin: string;
  try {
    renderedOrigin = new URL(rendered).origin;
  } catch {
    throw new UrlTemplateError('http url is invalid');
  }
  if (renderedOrigin !== origin) throw new UrlTemplateError('http url template must not change the destination origin');
  return rendered;
}

export interface StepContext {
  input: Record<string, unknown>;
  steps: Record<string, unknown>;
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
const FIXED_ORIGIN = /^(https?:\/\/[^/?#{}\s]+)[/?#]/i;
const INHERITED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

export class UrlTemplateError extends Error {}
export class BodyTemplateError extends Error {}

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

const JSON_MEDIA_TYPE = /^(application|text)\/([a-z0-9.!#$&^_-]+\+)?(x-)?json\s*(;|$)/;
const LOOKS_LIKE_JSON = /^\s*[[{]/;
const FORM_MEDIA_TYPE = /^application\/x-www-form-urlencoded\s*(;|$)/;

export function bodyFormatOf(template: string, headers: Record<string, string> = {}): BodyFormat {
  const contentType = Object.entries(headers)
    .find(([name]) => name.toLowerCase() === 'content-type')?.[1]
    ?.trim()
    .toLowerCase();
  if (contentType !== undefined && JSON_MEDIA_TYPE.test(contentType)) return 'json';
  if (contentType !== undefined && FORM_MEDIA_TYPE.test(contentType)) return 'form';
  return LOOKS_LIKE_JSON.test(template) ? 'json' : 'text';
}

function textOf(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export const UNFINISHED_JSON_ESCAPE = 'a backslash must not come right before a placeholder inside a JSON string';

class JsonStringTracker {
  inString = false;
  private escaped = false;

  endsInsideEscape(literal: string): boolean {
    for (const char of literal) {
      if (this.escaped) this.escaped = false;
      else if (this.inString && char === '\\') this.escaped = true;
      else if (char === '"') this.inString = !this.inString;
    }
    const unfinished = this.escaped;
    this.escaped = false;
    return unfinished;
  }
}

function renderJsonTemplate(template: string, ctx: StepContext, limit: RenderLimit): string {
  const tracker = new JsonStringTracker();
  return renderWith(template, limit, (path, literal) => {
    if (tracker.endsInsideEscape(literal)) throw new BodyTemplateError(UNFINISHED_JSON_ESCAPE);
    const value = lookup(ctx, path);
    return tracker.inString ? JSON.stringify(textOf(value)).slice(1, -1) : JSON.stringify(value ?? null);
  }).toString();
}

export function hasUnfinishedJsonEscape(template: string): boolean {
  const tracker = new JsonStringTracker();
  let last = 0;
  for (const match of template.matchAll(new RegExp(PLACEHOLDER.source, 'g'))) {
    if (tracker.endsInsideEscape(template.slice(last, match.index))) return true;
    last = match.index + match[0].length;
  }
  return false;
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

const DOT_SEGMENT = /^(\.|%2e){1,2}$/i;

function hasDotSegment(url: string): boolean {
  const path = url.replace(/^[a-z]+:\/\/[^/?#]*/i, '').split(/[?#]/, 1)[0];
  return path.split('/').some((segment) => DOT_SEGMENT.test(segment));
}

export const URL_BACKSLASH = 'http url must not contain a backslash';

export function renderUrlTemplate(template: string, ctx: StepContext): string {
  if (!hasPlaceholders(template)) return template;
  if (template.includes('\\')) throw new UrlTemplateError(URL_BACKSLASH);
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
  if (hasDotSegment(rendered)) throw new UrlTemplateError('http url path must not contain . or .. segments');
  return rendered;
}

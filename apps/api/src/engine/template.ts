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

export function renderTemplate(template: string, ctx: StepContext, encode: (value: string) => string = (value) => value): string {
  return template.replace(PLACEHOLDER, (_m, path: string) => {
    const value = lookup(ctx, path);
    if (value === undefined || value === null) return '';
    return encode(textOf(value));
  });
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

function renderJsonTemplate(template: string, ctx: StepContext): string {
  let rendered = '';
  let last = 0;
  let inString = false;
  let escaped = false;
  for (const match of template.matchAll(new RegExp(PLACEHOLDER.source, 'g'))) {
    const literal = template.slice(last, match.index);
    for (const char of literal) {
      if (escaped) escaped = false;
      else if (inString && char === '\\') escaped = true;
      else if (char === '"') inString = !inString;
    }
    const value = lookup(ctx, match[1]);
    rendered += literal + (inString ? JSON.stringify(textOf(value)).slice(1, -1) : JSON.stringify(value ?? null));
    escaped = false;
    last = match.index + match[0].length;
  }
  return rendered + template.slice(last);
}

export function renderBodyTemplate(template: string, ctx: StepContext, format: BodyFormat): string {
  if (format === 'json') return renderJsonTemplate(template, ctx);
  if (format === 'form') return renderTemplate(template, ctx, encodeURIComponent);
  return renderTemplate(template, ctx);
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
  const rendered = renderTemplate(template, ctx, encodeURIComponent);
  let renderedOrigin: string;
  try {
    renderedOrigin = new URL(rendered).origin;
  } catch {
    throw new UrlTemplateError('http url is invalid');
  }
  if (renderedOrigin !== origin) throw new UrlTemplateError('http url template must not change the destination origin');
  return rendered;
}

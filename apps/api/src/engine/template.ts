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
    return encode(typeof value === 'object' ? JSON.stringify(value) : String(value));
  });
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

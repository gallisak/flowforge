export const MAX_JSON_DEPTH = 64;

const QUOTE = 34;
const BACKSLASH = 92;
const OPENERS = new Set([91, 123]);
const CLOSERS = new Set([93, 125]);

export function jsonTextExceedsDepth(text: string, limit: number): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (code === BACKSLASH) escaped = true;
      else if (code === QUOTE) inString = false;
    } else if (code === QUOTE) {
      inString = true;
    } else if (OPENERS.has(code)) {
      depth++;
      if (depth > limit) return true;
    } else if (CLOSERS.has(code)) {
      depth--;
    }
  }
  return false;
}

export function valueExceedsDepth(value: unknown, limit: number): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  for (let next = pending.pop(); next; next = pending.pop()) {
    if (next.value === null || typeof next.value !== 'object') continue;
    if (next.depth > limit) return true;
    for (const child of Object.values(next.value)) pending.push({ value: child, depth: next.depth + 1 });
  }
  return false;
}

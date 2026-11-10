const NUL = '\u0000';
const REPLACEMENT = '\uFFFD';

export function containsNul(text: string): boolean {
  return text.includes(NUL);
}

export function storableText(text: string): string {
  return text.replaceAll(NUL, REPLACEMENT);
}

export function toStorable(value: unknown): unknown {
  if (typeof value === 'string') return storableText(value);
  if (Array.isArray(value)) return value.map(toStorable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [storableText(key), toStorable(item)]));
  }
  return value;
}

export function rejectNulReviver(key: string, value: unknown): unknown {
  if (containsNul(key) || (typeof value === 'string' && containsNul(value))) {
    throw new SyntaxError('JSON strings must not contain the NUL character');
  }
  return value;
}

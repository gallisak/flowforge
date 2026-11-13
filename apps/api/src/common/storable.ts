const NUL = '\u0000';
const REPLACEMENT = '\uFFFD';

export function containsNul(text: string): boolean {
  return text.includes(NUL);
}

export function storableText(text: string): string {
  return text.replaceAll(NUL, REPLACEMENT).toWellFormed();
}

export function truncatedText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const lastKept = text.charCodeAt(maxLength - 1);
  const splitsPair = lastKept >= 0xd800 && lastKept <= 0xdbff;
  return text.slice(0, splitsPair ? maxLength - 1 : maxLength);
}

export function toStorable(value: unknown): unknown {
  if (typeof value === 'string') return storableText(value);
  if (Array.isArray(value)) return value.map(toStorable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [storableText(key), toStorable(item)]));
  }
  return value;
}

function isStorableText(text: string): boolean {
  return !containsNul(text) && text.isWellFormed();
}

export function rejectUnstorableJson(key: string, value: unknown): unknown {
  if (key === '__proto__') throw new SyntaxError('JSON objects must not have a "__proto__" key');
  if (!isStorableText(key) || (typeof value === 'string' && !isStorableText(value))) {
    throw new SyntaxError('JSON strings must not contain the NUL character or unpaired UTF-16 surrogates');
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new SyntaxError('JSON numbers must fit in a double-precision number');
  }
  return value;
}

import { BadRequestException } from '@nestjs/common';

export interface ExecutionCursor {
  createdAt: string;
  id: string;
}

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?$/;

function isRealTimestamp(text: string): boolean {
  const parts = TIMESTAMP.exec(text);
  if (!parts) return false;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    year >= 1 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(cursor: ExecutionCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id])).toString('base64url');
}

export function decodeCursor(raw: string): ExecutionCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestException('cursor is invalid');
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw new BadRequestException('cursor is invalid');
  const [createdAt, id] = parsed;
  if (typeof createdAt !== 'string' || !isRealTimestamp(createdAt) || typeof id !== 'string' || !UUID.test(id)) {
    throw new BadRequestException('cursor is invalid');
  }
  return { createdAt, id };
}

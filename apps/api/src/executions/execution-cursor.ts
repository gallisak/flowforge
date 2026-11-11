import { BadRequestException } from '@nestjs/common';

export interface ExecutionCursor {
  createdAt: string;
  id: string;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/;
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
  if (typeof createdAt !== 'string' || !TIMESTAMP.test(createdAt) || typeof id !== 'string' || !UUID.test(id)) {
    throw new BadRequestException('cursor is invalid');
  }
  return { createdAt, id };
}

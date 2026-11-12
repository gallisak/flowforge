import { BadRequestException } from '@nestjs/common';
import { decodeCursor, encodeCursor } from '../src/executions/execution-cursor';

const ID = '5d1f8d1e-3c1a-4f7e-9a51-2f9c5c1a0b11';
const raw = (createdAt: string) => Buffer.from(JSON.stringify([createdAt, ID])).toString('base64url');

describe('execution cursor', () => {
  it.each(['2026-13-45 99:99:99', '2026-02-30 10:00:00', '2026-01-01 24:00:00', '0000-01-01 00:00:00'])(
    'refuses %s, which looks like a timestamp but is not one',
    (createdAt) => {
      expect(() => decodeCursor(raw(createdAt))).toThrow(BadRequestException);
    },
  );

  it('reads back a cursor it wrote', () => {
    const cursor = { createdAt: '2026-02-28 23:59:59.123456', id: ID };

    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });
});

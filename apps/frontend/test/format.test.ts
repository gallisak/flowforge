import { describe, expect, it } from 'vitest';
import { formatDateTime, formatDuration } from '@/lib/format';

describe('formatDateTime in a time zone', () => {
  it('shows the next run of a schedule in its own time zone, with the zone named', () => {
    const text = formatDateTime('2026-11-20T07:00:00Z', 'Europe/Kyiv');

    expect(text).toContain('09:00:00');
    expect(text).toMatch(/EET|GMT\+2/);
  });
});

describe('formatDuration', () => {
  const START = '2026-11-20T07:00:00.000Z';
  const after = (ms: number) => formatDuration(START, new Date(Date.parse(START) + ms).toISOString());

  it.each([
    [119_600, '2 min 0 s'],
    [59_600, '59.6 s'],
    [59_960, '1 min 0 s'],
    [60_000, '1 min 0 s'],
    [61_400, '1 min 1 s'],
    [3_599_500, '60 min 0 s'],
  ])('shows %i ms as %s without carrying 60 seconds', (ms, text) => {
    expect(after(ms)).toBe(text);
  });
});

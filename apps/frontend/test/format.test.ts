import { describe, expect, it } from 'vitest';
import { formatDateTime } from '@/lib/format';

describe('formatDateTime in a time zone', () => {
  it('shows the next run of a schedule in its own time zone, with the zone named', () => {
    const text = formatDateTime('2026-11-20T07:00:00Z', 'Europe/Kyiv');

    expect(text).toContain('09:00:00');
    expect(text).toMatch(/EET|GMT\+2/);
  });
});

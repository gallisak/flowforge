import { CronSchedule, FiringLimits, MissedRunPolicy, nextOccurrence, planFiring } from '../src/scheduler/cron-schedule';

const iso = (dates: Date[]) => dates.map((date) => date.toISOString());
const at = (value: string) => new Date(value);
const LIMITS: FiringLimits = { misfireGraceMs: 60_000, maxCatchUpRuns: 100 };

function chain(schedule: CronSchedule, first: string, count: number): string[] {
  const found = [at(first)];
  while (found.length < count) found.push(nextOccurrence(schedule, found[found.length - 1]));
  return iso(found);
}

describe('nextOccurrence', () => {
  it.each([
    ['UTC', '2026-11-20T00:00:00Z', '2026-11-20T09:00:00.000Z'],
    ['Europe/Kyiv', '2026-11-20T00:00:00Z', '2026-11-20T07:00:00.000Z'],
    ['Europe/Kyiv', '2026-07-01T00:00:00Z', '2026-07-01T06:00:00.000Z'],
    ['America/New_York', '2026-11-20T00:00:00Z', '2026-11-20T14:00:00.000Z'],
    ['America/New_York', '2026-07-01T00:00:00Z', '2026-07-01T13:00:00.000Z'],
    ['Asia/Kolkata', '2026-11-20T00:00:00Z', '2026-11-20T03:30:00.000Z'],
    ['Australia/Lord_Howe', '2026-06-01T00:00:00Z', '2026-06-01T22:30:00.000Z'],
    ['Australia/Lord_Howe', '2026-12-01T00:00:00Z', '2026-12-01T22:00:00.000Z'],
  ])('fires a daily 09:00 schedule in %s after %s at %s', (timezone, after, expected) => {
    expect(nextOccurrence({ cron: '0 9 * * *', timezone }, at(after)).toISOString()).toBe(expected);
  });

  it('returns an occurrence strictly after the given moment', () => {
    expect(nextOccurrence({ cron: '0 9 * * *', timezone: 'UTC' }, at('2026-11-20T09:00:00Z')).toISOString()).toBe(
      '2026-11-21T09:00:00.000Z',
    );
  });

  it('shifts a time that falls into the spring gap by the length of the gap, once', () => {
    expect(chain({ cron: '30 3 * * *', timezone: 'Europe/Kyiv' }, '2026-03-28T01:30:00Z', 3)).toEqual([
      '2026-03-28T01:30:00.000Z',
      '2026-03-29T01:30:00.000Z',
      '2026-03-30T00:30:00.000Z',
    ]);
    expect(chain({ cron: '30 2 * * *', timezone: 'America/New_York' }, '2026-03-07T07:30:00Z', 3)).toEqual([
      '2026-03-07T07:30:00.000Z',
      '2026-03-08T07:30:00.000Z',
      '2026-03-09T06:30:00.000Z',
    ]);
  });

  it('fires a time that happens twice in the autumn only at its first occurrence', () => {
    expect(chain({ cron: '30 3 * * *', timezone: 'Europe/Kyiv' }, '2026-10-24T00:30:00Z', 3)).toEqual([
      '2026-10-24T00:30:00.000Z',
      '2026-10-25T00:30:00.000Z',
      '2026-10-26T01:30:00.000Z',
    ]);
    expect(chain({ cron: '30 1 * * *', timezone: 'America/New_York' }, '2026-10-31T05:30:00Z', 3)).toEqual([
      '2026-10-31T05:30:00.000Z',
      '2026-11-01T05:30:00.000Z',
      '2026-11-02T06:30:00.000Z',
    ]);
  });

  it('runs an interval schedule by elapsed time across the autumn change, without duplicates', () => {
    const runs = chain({ cron: '*/30 * * * *', timezone: 'America/New_York' }, '2026-11-01T05:00:00Z', 5);

    expect(runs).toEqual([
      '2026-11-01T05:00:00.000Z',
      '2026-11-01T05:30:00.000Z',
      '2026-11-01T06:00:00.000Z',
      '2026-11-01T06:30:00.000Z',
      '2026-11-01T07:00:00.000Z',
    ]);
  });
});

describe('planFiring', () => {
  const hourly: CronSchedule = { cron: '0 * * * *', timezone: 'UTC' };
  const plan = (policy: MissedRunPolicy, nextRunAt: string, now: string, limits = LIMITS) =>
    planFiring(hourly, policy, at(nextRunAt), at(now), limits);

  it('fires nothing before the next run is due', () => {
    const result = plan('once', '2026-11-20T09:00:00Z', '2026-11-20T08:59:59Z');

    expect(result).toEqual({ fire: [], droppedMissedRuns: false, nextRunAt: at('2026-11-20T09:00:00Z') });
  });

  it.each<MissedRunPolicy>(['skip', 'once', 'all'])('fires an on-time occurrence under the %s policy', (policy) => {
    const result = plan(policy, '2026-11-20T09:00:00Z', '2026-11-20T09:00:05Z');

    expect(iso(result.fire)).toEqual(['2026-11-20T09:00:00.000Z']);
    expect(result.nextRunAt.toISOString()).toBe('2026-11-20T10:00:00.000Z');
  });

  it.each<[MissedRunPolicy, string[]]>([
    ['skip', []],
    ['once', ['2026-11-20T19:00:00.000Z']],
    [
      'all',
      Array.from({ length: 10 }, (_, i) => `2026-11-20T${String(10 + i).padStart(2, '0')}:00:00.000Z`),
    ],
  ])('applies the %s policy to occurrences missed during an outage', (policy, expected) => {
    const result = plan(policy, '2026-11-20T10:00:00Z', '2026-11-20T19:30:00Z');

    expect(iso(result.fire)).toEqual(expected);
    expect(result.nextRunAt.toISOString()).toBe('2026-11-20T20:00:00.000Z');
  });

  it('does not add a catch-up run under the once policy when an occurrence is on time', () => {
    const result = plan('once', '2026-11-20T10:00:00Z', '2026-11-20T12:00:30Z');

    expect(iso(result.fire)).toEqual(['2026-11-20T12:00:00.000Z']);
  });

  it('fires missed and on-time occurrences in order under the all policy', () => {
    const result = plan('all', '2026-11-20T10:00:00Z', '2026-11-20T12:00:30Z');

    expect(iso(result.fire)).toEqual(['2026-11-20T10:00:00.000Z', '2026-11-20T11:00:00.000Z', '2026-11-20T12:00:00.000Z']);
  });

  it('starts only the latest missed runs above the catch-up limit and reports the rest as dropped', () => {
    const limited = { ...LIMITS, maxCatchUpRuns: 3 };

    const result = plan('all', '2026-11-20T10:00:00Z', '2026-11-20T19:30:00Z', limited);

    expect(iso(result.fire)).toEqual(['2026-11-20T17:00:00.000Z', '2026-11-20T18:00:00.000Z', '2026-11-20T19:00:00.000Z']);
    expect(result.droppedMissedRuns).toBe(true);
  });

  it('does not report dropped runs when the missed runs fit the limit exactly', () => {
    const result = plan('all', '2026-11-20T17:00:00Z', '2026-11-20T19:30:00Z', { ...LIMITS, maxCatchUpRuns: 3 });

    expect(result.fire).toHaveLength(3);
    expect(result.droppedMissedRuns).toBe(false);
  });

  it('plans a catch-up after a year long outage of an every-minute schedule without walking every minute', () => {
    const everyMinute: CronSchedule = { cron: '* * * * *', timezone: 'Europe/Kyiv' };
    const once = planFiring(everyMinute, 'once', at('2025-11-20T00:00:00Z'), at('2026-11-20T00:00:30Z'), {
      misfireGraceMs: 10_000,
      maxCatchUpRuns: 100,
    });
    const all = planFiring(everyMinute, 'all', at('2025-11-20T00:00:00Z'), at('2026-11-20T00:00:30Z'), {
      misfireGraceMs: 10_000,
      maxCatchUpRuns: 3,
    });

    expect(iso(once.fire)).toEqual(['2026-11-20T00:00:00.000Z']);
    expect(iso(all.fire)).toEqual(['2026-11-19T23:58:00.000Z', '2026-11-19T23:59:00.000Z', '2026-11-20T00:00:00.000Z']);
    expect(once.nextRunAt.toISOString()).toBe('2026-11-20T00:01:00.000Z');
  }, 10_000);

  it('keeps the shifted spring occurrence when a tick lands between the gap and that occurrence', () => {
    const kyiv: CronSchedule = { cron: '30 3 * * *', timezone: 'Europe/Kyiv' };

    const early = planFiring(kyiv, 'once', at('2026-03-29T01:30:00Z'), at('2026-03-29T01:10:00Z'), LIMITS);
    const due = planFiring(kyiv, 'once', at('2026-03-29T01:30:00Z'), at('2026-03-29T01:30:05Z'), LIMITS);

    expect(early.fire).toEqual([]);
    expect(iso(due.fire)).toEqual(['2026-03-29T01:30:00.000Z']);
    expect(due.nextRunAt.toISOString()).toBe('2026-03-30T00:30:00.000Z');
  });

  it('catches up on a shifted spring occurrence that was missed during an outage', () => {
    const newYork: CronSchedule = { cron: '30 2 * * *', timezone: 'America/New_York' };

    const result = planFiring(newYork, 'all', at('2026-03-08T07:30:00Z'), at('2026-03-08T12:00:00Z'), LIMITS);

    expect(iso(result.fire)).toEqual(['2026-03-08T07:30:00.000Z']);
    expect(result.nextRunAt.toISOString()).toBe('2026-03-09T06:30:00.000Z');
  });
});

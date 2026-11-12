import { planFiring, SKIPPED_RUNS_COUNT_CAP } from '../src/scheduler/cron-schedule';

describe('counting runs skipped during a long outage', () => {
  it('stops counting early, so that a claim of a minutely schedule a day late stays cheap', () => {
    const now = new Date('2026-11-12T12:00:00Z');
    const dayLate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    planFiring({ cron: '* * * * *', timezone: 'UTC' }, 'skip', dayLate, now, { misfireGraceMs: 60_000, maxCatchUpRuns: 100 });

    const started = performance.now();
    const plan = planFiring({ cron: '* * * * *', timezone: 'Europe/Kyiv' }, 'skip', dayLate, now, { misfireGraceMs: 60_000, maxCatchUpRuns: 100 });

    expect(performance.now() - started).toBeLessThan(250);
    expect(plan).toMatchObject({ skippedRuns: SKIPPED_RUNS_COUNT_CAP, skippedRunsCapped: true });
    expect(SKIPPED_RUNS_COUNT_CAP).toBe(100);
  });
});

import { parseExpression } from 'cron-parser';
import { planFiring, SKIPPED_RUNS_COUNT_CAP } from '../src/scheduler/cron-schedule';

describe('counting runs skipped during a long outage', () => {
  const cronSteps = jest.spyOn(Object.getPrototypeOf(parseExpression('* * * * *')), 'next');
  const now = new Date('2026-11-12T12:00:00Z');

  afterAll(() => cronSteps.mockRestore());

  it.each([1, 7, 30])('stops counting early, so that a claim of a minutely schedule %i day(s) late stays cheap', (days) => {
    cronSteps.mockClear();
    const late = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const plan = planFiring({ cron: '* * * * *', timezone: 'Europe/Kyiv' }, 'skip', late, now, { misfireGraceMs: 60_000, maxCatchUpRuns: 100 });

    expect(plan).toMatchObject({ skippedRuns: SKIPPED_RUNS_COUNT_CAP, skippedRunsCapped: true });
    expect(SKIPPED_RUNS_COUNT_CAP).toBe(100);
    expect(cronSteps.mock.calls.length).toBeLessThanOrEqual(2 * SKIPPED_RUNS_COUNT_CAP);
  });
});

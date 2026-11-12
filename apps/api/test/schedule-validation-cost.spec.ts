import { parseExpression } from 'cron-parser';
import { timezoneCacheSize, utcOffsetMs } from '../src/scheduler/zoned-cron';
import { validateSchedule } from '../src/workflows/schedule';

describe('cost of schedule validation', () => {
  const cronSteps = jest.spyOn(Object.getPrototypeOf(parseExpression('* * * * *')), 'next');

  function stepsToValidate(msPerClockRead: number): number {
    let clock = 0;
    const now = jest.spyOn(performance, 'now').mockImplementation(() => (clock += msPerClockRead));
    cronSteps.mockClear();
    try {
      validateSchedule('59 59 23 29 2 *', 'Australia/Lord_Howe');
    } finally {
      now.mockRestore();
    }
    return cronSteps.mock.calls.length;
  }

  afterAll(() => cronSteps.mockRestore());

  it('stops sampling a sparse cron once its time budget is spent', () => {
    expect(stepsToValidate(0)).toBe(10);
    expect(stepsToValidate(25)).toBe(2);
  });
});

describe('time zone formatter cache', () => {
  const caseVariants = (zone: string, count: number) =>
    Array.from({ length: count }, (_, n) => [...zone].map((char, i) => ((n >> i % 20) & 1 ? char.toUpperCase() : char.toLowerCase())).join(''));

  it('keeps one formatter per zone however its name is spelled', () => {
    const before = timezoneCacheSize().formatters;
    for (const spelling of caseVariants('America/New_York', 50)) utcOffsetMs(spelling, Date.UTC(2026, 0, 1));

    expect(timezoneCacheSize().formatters - before).toBeLessThanOrEqual(1);
  });

  it('forgets old spellings instead of growing without limit', () => {
    for (const spelling of caseVariants('Europe/Kyiv', 3_000)) utcOffsetMs(spelling, Date.UTC(2026, 0, 1));

    expect(timezoneCacheSize().spellings).toBeLessThanOrEqual(1_000);
  });
});

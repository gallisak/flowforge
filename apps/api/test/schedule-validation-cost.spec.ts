import { timezoneCacheSize, utcOffsetMs } from '../src/scheduler/zoned-cron';
import { validateSchedule } from '../src/workflows/schedule';

describe('cost of schedule validation', () => {
  it('validates a sparse cron in a time zone with half-hour changes in a few milliseconds', () => {
    validateSchedule('0 0 1 1 *', 'UTC');
    const started = performance.now();
    for (let i = 0; i < 5; i++) validateSchedule('59 59 23 29 2 *', 'Australia/Lord_Howe');

    expect((performance.now() - started) / 5).toBeLessThan(60);
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

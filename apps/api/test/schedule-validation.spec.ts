import { BadRequestException } from '@nestjs/common';
import { isValidTimezone, validateSchedule } from '../src/workflows/schedule';

const NOW = new Date('2026-03-28T12:00:00Z');

describe('validateSchedule', () => {
  it.each([
    ['0 9 * * *', 'Europe/Kyiv'],
    ['*/5 * * * *', 'UTC'],
    ['0 * * * * *', 'America/New_York'],
    ['30 2 * * *', 'America/New_York'],
    ['0 0 1 1 *', 'Asia/Kolkata'],
  ])('accepts %s in %s', (cron, timezone) => {
    expect(() => validateSchedule(cron, timezone, NOW)).not.toThrow();
  });

  it('accepts a workflow without a schedule', () => {
    expect(() => validateSchedule(null, 'UTC', NOW)).not.toThrow();
  });

  it.each(['* * * * * *', '*/30 * * * * *', '0,30 * * * * *', '0,1 0 0 1 1 *'])(
    'rejects %s because it fires more often than once per minute',
    (cron) => {
      expect(() => validateSchedule(cron, 'UTC', NOW)).toThrow('cron must not fire more often than once per minute');
    },
  );

  it.each(['not a cron', '60 * * * *', '* * * *', '0 0 31 2 *'])('rejects the invalid expression %p', (cron) => {
    expect(() => validateSchedule(cron, 'UTC', NOW)).toThrow(BadRequestException);
  });

  it('rejects an expression that is too long', () => {
    expect(() => validateSchedule(`0 0 * * ${'1,'.repeat(60)}1`, 'UTC', NOW)).toThrow(BadRequestException);
  });

  it.each(['Mars/Phobos', 'UTC+3', ''])('rejects the timezone %p', (timezone) => {
    expect(() => validateSchedule('0 9 * * *', timezone, NOW)).toThrow('timezone must be a valid IANA time zone');
  });

  it('validates the timezone even without a schedule', () => {
    expect(() => validateSchedule(null, 'Not/AZone', NOW)).toThrow(BadRequestException);
  });
});

describe('isValidTimezone', () => {
  it.each(['UTC', 'Europe/Kyiv', 'America/New_York', 'Asia/Kolkata', 'Australia/Lord_Howe'])('accepts %s', (tz) => {
    expect(isValidTimezone(tz)).toBe(true);
  });
});

import { BadRequestException } from '@nestjs/common';
import { parseExpression } from 'cron-parser';
import { ZonedCronIterator } from '../scheduler/zoned-cron';

const MAX_CRON_LENGTH = 100;
const SAMPLED_OCCURRENCES = 3;

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function validateSchedule(cron: string | null, timezone: string, now = new Date()): void {
  if (!isValidTimezone(timezone)) {
    throw new BadRequestException('timezone must be a valid IANA time zone');
  }
  if (cron === null) return;
  if (cron.length > MAX_CRON_LENGTH) {
    throw new BadRequestException(`cron must be at most ${MAX_CRON_LENGTH} characters`);
  }
  const fields = cron.trim().split(/\s+/).length;
  if (fields !== 5 && fields !== 6) {
    throw new BadRequestException('cron must have 5 fields, or 6 with seconds');
  }

  let secondsPerMinute: number;
  try {
    secondsPerMinute = parseExpression(cron, { tz: 'UTC' }).fields.second.length;
    const iterator = new ZonedCronIterator(cron, timezone, now);
    for (let sampled = 0; sampled < SAMPLED_OCCURRENCES; sampled++) iterator.next();
  } catch {
    throw new BadRequestException('cron must be a valid cron expression');
  }
  if (secondsPerMinute > 1) {
    throw new BadRequestException('cron must not fire more often than once per minute');
  }
}

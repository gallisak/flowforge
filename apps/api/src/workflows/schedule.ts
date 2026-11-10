import { BadRequestException } from '@nestjs/common';
import { parseExpression } from 'cron-parser';

export const MIN_SCHEDULE_INTERVAL_MS = 60_000;
const MAX_CRON_LENGTH = 100;
const SAMPLED_OCCURRENCES = 10;

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

  let occurrences: number[];
  try {
    const iterator = parseExpression(cron, { currentDate: now, tz: timezone });
    occurrences = Array.from({ length: SAMPLED_OCCURRENCES }, () => iterator.next().getTime());
  } catch {
    throw new BadRequestException('cron must be a valid cron expression');
  }

  for (let i = 1; i < occurrences.length; i++) {
    if (occurrences[i] - occurrences[i - 1] < MIN_SCHEDULE_INTERVAL_MS) {
      throw new BadRequestException('cron must not fire more often than once per minute');
    }
  }
}

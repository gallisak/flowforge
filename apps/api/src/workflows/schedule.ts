import { BadRequestException } from '@nestjs/common';
import { ZonedCronIterator } from '../scheduler/zoned-cron';

export const MIN_SCHEDULE_INTERVAL_MS = 60_000;
const MAX_CRON_LENGTH = 100;
const SAMPLED_OCCURRENCES = 10;
const VALIDATION_BUDGET_MS = 20;

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

  const occurrences: number[] = [];
  const started = performance.now();
  try {
    const iterator = new ZonedCronIterator(cron, timezone, now);
    while (occurrences.length < SAMPLED_OCCURRENCES) {
      occurrences.push(iterator.next().getTime());
      if (occurrences.length >= 2 && performance.now() - started > VALIDATION_BUDGET_MS) break;
    }
  } catch {
    throw new BadRequestException('cron must be a valid cron expression');
  }

  for (let i = 1; i < occurrences.length; i++) {
    if (occurrences[i] - occurrences[i - 1] < MIN_SCHEDULE_INTERVAL_MS) {
      throw new BadRequestException('cron must not fire more often than once per minute');
    }
  }
}

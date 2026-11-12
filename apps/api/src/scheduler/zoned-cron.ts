import { CronExpression, parseExpression } from 'cron-parser';

const HOUR_MS = 60 * 60 * 1000;
const BEFORE_ANY_LOCAL_TIME_MS = 15 * HOUR_MS;
const AFTER_ANY_LOCAL_TIME_MS = 13 * HOUR_MS;
const NEARBY_MS = 30 * HOUR_MS;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

export function utcOffsetMs(timezone: string, instantMs: number): number {
  const fields: Record<string, number> = {};
  for (const part of formatterFor(timezone).formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value);
  }
  const wallMs = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second);
  return wallMs - Math.floor(instantMs / 1000) * 1000;
}

export function followsWallClockByHour(cron: string): boolean {
  const fields = cron.trim().split(/\s+/);
  const hour = fields.length === 6 ? fields[2] : fields[1];
  return hour.startsWith('*');
}

interface WallTime {
  instants: number[];
  maxOffsetMs: number;
}

function instantsOfWallTime(timezone: string, wallMs: number, byElapsedTime: boolean): WallTime {
  const before = utcOffsetMs(timezone, wallMs - BEFORE_ANY_LOCAL_TIME_MS);
  const after = utcOffsetMs(timezone, wallMs + AFTER_ANY_LOCAL_TIME_MS);
  const maxOffsetMs = Math.max(before, after);
  if (before === after) return { instants: [wallMs - before], maxOffsetMs };
  const valid = [before, after]
    .filter((offset) => utcOffsetMs(timezone, wallMs - offset) === offset)
    .map((offset) => wallMs - offset)
    .sort((a, b) => a - b);
  if (valid.length === 0) return { instants: byElapsedTime ? [] : [wallMs - before], maxOffsetMs };
  return { instants: byElapsedTime ? valid : valid.slice(0, 1), maxOffsetMs };
}

export class ZonedCronIterator {
  private readonly wallTimes: CronExpression;
  private readonly byElapsedTime: boolean;
  private readonly pending: number[] = [];
  private emitUpTo = Number.NEGATIVE_INFINITY;
  private lastEmitted: number;

  constructor(
    cron: string,
    private readonly timezone: string,
    after: Date,
  ) {
    const afterMs = after.getTime();
    const offsets = [afterMs - NEARBY_MS, afterMs, afterMs + NEARBY_MS].map((instant) => utcOffsetMs(timezone, instant));
    const firstWallMs = afterMs + Math.min(...offsets);
    this.wallTimes = parseExpression(cron, { currentDate: new Date(firstWallMs - 1000), tz: 'UTC' });
    this.byElapsedTime = followsWallClockByHour(cron);
    this.lastEmitted = afterMs;
  }

  next(): Date {
    for (;;) {
      if (this.pending.length > 0 && this.pending[0] <= this.emitUpTo) {
        const instant = this.pending.shift() as number;
        if (instant <= this.lastEmitted) continue;
        this.lastEmitted = instant;
        return new Date(instant);
      }
      const wallMs = this.wallTimes.next().getTime();
      const { instants, maxOffsetMs } = instantsOfWallTime(this.timezone, wallMs, this.byElapsedTime);
      for (const instant of instants) {
        if (instant <= this.lastEmitted || this.pending.includes(instant)) continue;
        const position = this.pending.findIndex((queued) => queued > instant);
        this.pending.splice(position === -1 ? this.pending.length : position, 0, instant);
      }
      this.emitUpTo = wallMs - maxOffsetMs;
    }
  }
}

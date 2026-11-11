import { parseExpression } from 'cron-parser';

export const MISSED_RUN_POLICIES = ['skip', 'once', 'all'] as const;
export type MissedRunPolicy = (typeof MISSED_RUN_POLICIES)[number];

export interface CronSchedule {
  cron: string;
  timezone: string;
}

export interface FiringLimits {
  misfireGraceMs: number;
  maxCatchUpRuns: number;
}

export interface FiringPlan {
  fire: Date[];
  droppedMissedRuns: boolean;
  nextRunAt: Date;
}

const FIRST_SEARCH_WINDOW_MS = 60 * 60 * 1000;

function iterate(schedule: CronSchedule, after: Date) {
  return parseExpression(schedule.cron, { currentDate: after, tz: schedule.timezone });
}

export function nextOccurrence(schedule: CronSchedule, after: Date): Date {
  return iterate(schedule, after).next().toDate();
}

function occurrencesBetween(schedule: CronSchedule, from: Date, to: Date): Date[] {
  return followChain(schedule, new Date(from.getTime() - 1), to, Infinity).found;
}

function followChain(schedule: CronSchedule, anchor: Date, until: Date, limit: number): { found: Date[]; next: Date } {
  const iterator = iterate(schedule, anchor);
  const found: Date[] = [];
  for (;;) {
    const next = iterator.next().toDate();
    if (next > until) return { found, next };
    if (found.length < limit) found.push(next);
  }
}

export function latestOccurrencesBefore(schedule: CronSchedule, knownOccurrence: Date, before: Date, limit: number): Date[] {
  const end = new Date(before.getTime() - 1);
  if (end < knownOccurrence) return [];
  for (let windowMs = FIRST_SEARCH_WINDOW_MS; ; windowMs *= 2) {
    const start = before.getTime() - windowMs;
    if (start <= knownOccurrence.getTime()) {
      return [knownOccurrence, ...followChain(schedule, knownOccurrence, end, Infinity).found].slice(-limit);
    }
    const found = occurrencesBetween(schedule, new Date(start), end);
    if (found.length >= limit) return found.slice(-limit);
  }
}

export function planFiring(
  schedule: CronSchedule,
  policy: MissedRunPolicy,
  nextRunAt: Date,
  now: Date,
  limits: FiringLimits,
): FiringPlan {
  if (nextRunAt > now) return { fire: [], droppedMissedRuns: false, nextRunAt };
  const graceStart = new Date(now.getTime() - limits.misfireGraceMs);

  let missed: Date[] = [];
  let anchor = nextRunAt;
  if (nextRunAt < graceStart) {
    missed = latestOccurrencesBefore(schedule, nextRunAt, graceStart, policy === 'all' ? limits.maxCatchUpRuns : 1);
    anchor = missed.at(-1) ?? nextRunAt;
  }
  const following = followChain(schedule, anchor, now, limits.maxCatchUpRuns);
  const onTime = nextRunAt < graceStart ? following.found : [nextRunAt, ...following.found];

  let catchUp: Date[] = [];
  if (policy === 'all') catchUp = missed;
  if (policy === 'once' && onTime.length === 0) catchUp = missed.slice(-1);

  return {
    fire: [...catchUp, ...onTime],
    droppedMissedRuns: policy === 'all' && missed.length === limits.maxCatchUpRuns && missed[0] > nextRunAt,
    nextRunAt: following.next,
  };
}

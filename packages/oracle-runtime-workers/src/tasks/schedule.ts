/**
 * Pure scheduling math for the tasks subsystem — next-fire computation for
 * the three trigger kinds (`once` / `cron` / `interval`), schedule
 * validation, run previews and the consecutive-failure backoff curve.
 *
 * Everything here is a pure function of its inputs so it can be unit-tested
 * without a Durable Object; the scheduler (`scheduler.ts`) supplies the
 * clock.
 */
import {
  CronExpression,
  CronExpressionParser,
  CronFieldCollection,
} from 'cron-parser';
import type { OracleTaskSchedule } from '../plugin-api/types';

/** Consecutive failed runs before a recurring task is stopped as `failed`. */
export const MAX_CONSECUTIVE_FAILURES = 3;

/** First-retry delay after a failed run; doubles per consecutive failure. */
export const FAILURE_BACKOFF_BASE_MS = 60_000;

/** Backoff ceiling — a retry is never pushed further out than this. */
export const FAILURE_BACKOFF_MAX_MS = 60 * 60_000;

/** Default for `TASKS_MAX_PER_USER` (live = active or paused tasks). */
export const DEFAULT_MAX_TASKS_PER_USER = 50;

/** Default for `TASKS_MIN_CRON_INTERVAL_SEC` (applies to `interval` too). */
export const DEFAULT_MIN_CRON_INTERVAL_SEC = 300;

/**
 * Next fire time (ms epoch) strictly after `fromMs`, or null when the
 * schedule has none (one-shot in the past, unparseable cron, bad interval).
 */
export function computeNextRunAtMs(
  schedule: OracleTaskSchedule,
  fromMs: number,
): number | null {
  switch (schedule.kind) {
    case 'once': {
      const at = Date.parse(schedule.at);
      if (Number.isNaN(at)) return null;
      return at > fromMs ? at : null;
    }
    case 'cron': {
      try {
        return CronExpressionParser.parse(schedule.cron, {
          currentDate: new Date(fromMs),
          ...(schedule.timezone ? { tz: schedule.timezone } : {}),
        })
          .next()
          .toDate()
          .getTime();
      } catch {
        return null;
      }
    }
    case 'interval': {
      if (
        !Number.isInteger(schedule.everySeconds) ||
        schedule.everySeconds <= 0
      ) {
        return null;
      }
      return fromMs + schedule.everySeconds * 1000;
    }
  }
}

/** The next `count` fire times as ISO strings (fewer when the schedule ends). */
export function previewRuns(
  schedule: OracleTaskSchedule,
  count: number,
  fromMs: number,
): string[] {
  const runs: string[] = [];
  let cursor = fromMs;
  for (let i = 0; i < count; i++) {
    const next = computeNextRunAtMs(schedule, cursor);
    if (next === null || next <= cursor) break;
    runs.push(new Date(next).toISOString());
    cursor = next;
  }
  return runs;
}

const DAY_MS = 86_400_000;
/** Calendar span searched for the two closest firing days (covers a leap year). */
const FIRING_DAY_SCAN_DAYS = 4 * 366;
/** How far ahead UTC-offset changes of the task's timezone are looked for. */
const OFFSET_CHANGE_LOOKAHEAD_DAYS = 366;
/**
 * Fires examined around one UTC-offset change. A pattern that fires more
 * often than this in three days is already below any practical floor on its
 * wall-clock gaps; the cap only bounds the work for tiny operator floors.
 */
const MAX_FIRES_PER_OFFSET_WINDOW = 3_000;
/**
 * How far around an offset change fires are examined when the pattern's
 * shortest gap is longer (weekly and rarer patterns): a gap of more than a
 * week minus the shift is not a frequency any floor is about.
 */
const MAX_OFFSET_WINDOW_REACH_MS = 7 * DAY_MS;

/** A timezone's UTC offset (ms) at `atMs`. Throws a RangeError for an unknown zone. */
function utcOffsetMs(format: Intl.DateTimeFormat, atMs: number): number {
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(new Date(atMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const wallClock = Date.UTC(
    parts.year ?? 0,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    (parts.hour ?? 0) % 24,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  return wallClock - Math.floor(atMs / 1000) * 1000;
}

/**
 * The fewest calendar days between two consecutive days the pattern's
 * date fields (day of month, month, day of week) select, over
 * `FIRING_DAY_SCAN_DAYS` from `fromMs`; Infinity when fewer than two match.
 */
function closestFiringDays(
  fields: CronFieldCollection,
  fromMs: number,
): number {
  if (
    fields.dayOfMonth.isWildcard &&
    fields.month.isWildcard &&
    fields.dayOfWeek.isWildcard
  ) {
    return 1;
  }
  const days = CronExpression.fieldsToExpression(
    CronFieldCollection.from(fields, { second: [0], minute: [0], hour: [0] }),
    { currentDate: new Date(fromMs), tz: 'UTC' },
  );
  const end = fromMs + FIRING_DAY_SCAN_DAYS * DAY_MS;
  let closest = Number.POSITIVE_INFINITY;
  let previous: number | undefined;
  while (days.hasNext()) {
    const day = days.next().getTime();
    if (day > end) break;
    if (previous !== undefined)
      closest = Math.min(closest, Math.round((day - previous) / DAY_MS));
    if (closest === 1) break;
    previous = day;
  }
  return closest;
}

/**
 * The shortest gap (ms) between consecutive fires of a cron pattern in
 * `timezone` (the runtime's zone when absent), or null when the pattern or
 * the timezone does not parse. Drives the minimum-frequency check, so it
 * covers every pair of consecutive fires, not just the next two:
 *
 *   - within a day: the closest two of the pattern's times of day;
 *   - across midnight: last time of one firing day → first time of the next
 *     firing day, for the two closest firing days (weekday lists, month ends
 *     and leap days included);
 *   - across a UTC-offset change of `timezone` in the coming year: the real
 *     elapsed time between the fires around it (a 01:00 / 04:00 pattern is
 *     2 hours apart on the day the clocks go forward).
 *
 * Infinity when the pattern fires at most once in the scanned span. A gap
 * below `floorMs` ends the search early (that is all the caller needs).
 */
export function cronIntervalMs(
  cron: string,
  timezone?: string,
  fromMs = Date.now(),
  floorMs = 0,
  examined?: { fires: number },
): number | null {
  let fields: CronFieldCollection;
  let offsetFormat: Intl.DateTimeFormat | undefined;
  try {
    fields = CronExpressionParser.parse(cron, {
      currentDate: new Date(fromMs),
      tz: 'UTC',
    }).fields;
    if (timezone) {
      offsetFormat = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    }
  } catch {
    return null;
  }

  // Wall-clock gaps: the pattern's times of day, then the step between days.
  const times: number[] = [];
  for (const hour of fields.hour.values)
    for (const minute of fields.minute.values)
      for (const second of fields.second.values)
        times.push((hour * 3600 + minute * 60 + second) * 1000);
  times.sort((a, b) => a - b);
  let shortest = Number.POSITIVE_INFINITY;
  for (let i = 1; i < times.length; i += 1)
    shortest = Math.min(shortest, times[i]! - times[i - 1]!);
  let firingDays: number;
  try {
    firingDays = closestFiringDays(fields, fromMs);
  } catch {
    return null;
  }
  if (Number.isFinite(firingDays) && times.length > 0) {
    shortest = Math.min(
      shortest,
      firingDays * DAY_MS - (times[times.length - 1]! - times[0]!),
    );
  }
  if (!offsetFormat || shortest < floorMs) return shortest;

  // Real elapsed time around each UTC-offset change in the coming year.
  const format = offsetFormat;
  let previousOffset = utcOffsetMs(format, fromMs);
  for (let day = 1; day <= OFFSET_CHANGE_LOOKAHEAD_DAYS; day += 1) {
    const dayMs = fromMs + day * DAY_MS;
    const offset = utcOffsetMs(format, dayMs);
    if (offset === previousOffset) continue;
    const shift = Math.abs(offset - previousOffset);
    previousOffset = offset;
    // The change instant, to the minute, between the two daily samples.
    let before = dayMs - DAY_MS;
    let after = dayMs;
    while (after - before > 60_000) {
      const mid = before + Math.floor((after - before) / 2);
      if (utcOffsetMs(format, mid) === offset) after = mid;
      else before = mid;
    }
    // Only a pair of fires that straddles the change can come closer than
    // its clock gap, and by at most `shift`: a pair that could beat the
    // gap found so far (or break the floor) is less than `reach` apart,
    // so both of its fires lie within `reach` of the change. Fires the
    // change moves (a time that does not exist that day) land within
    // `shift` after it.
    const reach =
      Math.min(
        shortest,
        floorMs > 0 ? floorMs : Number.POSITIVE_INFINITY,
        MAX_OFFSET_WINDOW_REACH_MS,
      ) + shift;
    const windowStart = after - reach;
    const windowEnd = after + shift + reach;
    try {
      const fires = CronExpressionParser.parse(cron, {
        currentDate: new Date(windowStart),
        tz: timezone,
      });
      let previous: number | undefined;
      for (let n = 0; n < MAX_FIRES_PER_OFFSET_WINDOW; n += 1) {
        const fire = fires.next().getTime();
        if (examined) examined.fires += 1;
        // cron-parser can stop advancing next to a change that is not a
        // whole hour (it returns the same fire again): the window ends there.
        if (fire > windowEnd || (previous !== undefined && fire <= previous))
          break;
        if (previous !== undefined)
          shortest = Math.min(shortest, fire - previous);
        if (shortest < floorMs) return shortest;
        previous = fire;
      }
    } catch {
      // The pattern has no fire left after this window (cron-parser throws
      // past its search horizon): nothing more to measure here.
    }
  }
  return shortest;
}

/**
 * Human-readable problems with a schedule; empty = valid. The minimum
 * interval floor applies to cron patterns AND `interval` schedules — a
 * one-shot only needs to be in the future.
 */
export function validateSchedule(
  schedule: OracleTaskSchedule,
  minIntervalSec: number,
  fromMs = Date.now(),
): string[] {
  const problems: string[] = [];
  switch (schedule.kind) {
    case 'once': {
      const at = Date.parse(schedule.at);
      if (Number.isNaN(at)) {
        problems.push(`"${schedule.at}" is not a valid ISO timestamp.`);
      } else if (at <= fromMs) {
        problems.push(
          `The one-shot time ${schedule.at} is in the past — pick a future time.`,
        );
      }
      break;
    }
    case 'cron': {
      const interval = cronIntervalMs(
        schedule.cron,
        schedule.timezone,
        fromMs,
        minIntervalSec * 1000,
      );
      if (interval === null) {
        problems.push(`Cron pattern "${schedule.cron}" is not valid.`);
      } else if (interval < minIntervalSec * 1000) {
        problems.push(
          `That cron schedule fires as little as ${Math.round(interval / 1000)}s apart — the minimum interval between runs is ${minIntervalSec}s. Pick a less frequent schedule.`,
        );
      }
      break;
    }
    case 'interval': {
      if (
        !Number.isInteger(schedule.everySeconds) ||
        schedule.everySeconds <= 0
      ) {
        problems.push('everySeconds must be a positive integer.');
      } else if (schedule.everySeconds < minIntervalSec) {
        problems.push(
          `An interval of ${schedule.everySeconds}s is below the minimum of ${minIntervalSec}s between runs.`,
        );
      }
      break;
    }
  }
  return problems;
}

/**
 * Delay before the next attempt after `consecutiveFailures` failed runs in a
 * row: base × 2^(n−1), capped. The scheduler takes the LATER of this and the
 * schedule's own next fire, so backoff can only push runs out, never pull
 * them in.
 */
export function backoffDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  const exp = Math.min(consecutiveFailures - 1, 30);
  return Math.min(FAILURE_BACKOFF_BASE_MS * 2 ** exp, FAILURE_BACKOFF_MAX_MS);
}

/** One-line human summary of a schedule (tool responses, log lines). */
export function summarizeSchedule(schedule: OracleTaskSchedule): string {
  switch (schedule.kind) {
    case 'once':
      return `once at ${schedule.at}`;
    case 'cron':
      return `cron \`${schedule.cron}\`${schedule.timezone ? ` (${schedule.timezone})` : ''}`;
    case 'interval':
      return `every ${schedule.everySeconds}s`;
  }
}

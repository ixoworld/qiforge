/**
 * Pure scheduling math for the tasks subsystem — next-fire computation for
 * the three trigger kinds (`once` / `cron` / `interval`), schedule
 * validation, run previews and the consecutive-failure backoff curve.
 *
 * Everything here is a pure function of its inputs so it can be unit-tested
 * without a Durable Object; the scheduler (`scheduler.ts`) supplies the
 * clock.
 */
import { CronExpressionParser } from 'cron-parser';
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

/**
 * Milliseconds between two consecutive fires of a cron pattern, or null when
 * the pattern does not parse. Drives the minimum-frequency check.
 */
export function cronIntervalMs(cron: string, timezone?: string): number | null {
  try {
    const it = CronExpressionParser.parse(cron, {
      ...(timezone ? { tz: timezone } : {}),
    });
    const a = it.next().toDate().getTime();
    const b = it.next().toDate().getTime();
    return b - a;
  } catch {
    return null;
  }
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
      const interval = cronIntervalMs(schedule.cron, schedule.timezone);
      if (interval === null) {
        problems.push(`Cron pattern "${schedule.cron}" is not valid.`);
      } else if (interval < minIntervalSec * 1000) {
        problems.push(
          `That cron schedule fires every ${Math.round(interval / 1000)}s — the minimum interval between runs is ${minIntervalSec}s. Pick a less frequent schedule.`,
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

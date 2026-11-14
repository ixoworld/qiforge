import { z } from 'zod';
import { selfTimeSeconds } from './times';

/**
 * Self's limit on identity-check starts, and how the person is told about it.
 *
 * Self lets a person start only a few identity checks in a rolling window
 * (3 in 6 hours; 3 in 24 hours before that). A start is counted when they
 * tap Start on the link page, not when a link is made. When none is left,
 * Self refuses a new link with 429 `daily_limit`, `resetsAt` (ISO 8601: when
 * the next start becomes available) and `Retry-After`; the link status says
 * the same in `limit: { code, resetsAt }`. A newer Self adds, on the refusal,
 * on the link status and on a created link: `resetsAt`, `retryAfterSeconds`,
 * `startsLeft` (0 to `startsMax`), `startsMax` and `windowHours`. Every field
 * is read leniently (absent, a wrong type or out of range is "unknown", never
 * a parse failure), so both shapes work.
 *
 * The wait is told as a friendly duration computed when it is said, never as
 * a raw time: "in about 5 hours", "in about 40 minutes", "in a few minutes".
 */

/** Self's error code for "no starts left in the window". */
export const START_LIMIT_CODE = 'daily_limit';

/** What Self said about the person's starts. `resetsAt` is Unix seconds. */
export interface Starts {
  /** Starts the person still has in the window (0 = none until `resetsAt`). */
  startsLeft?: number;
  /** Starts allowed in one window (3). */
  startsMax?: number;
  /** The window's length in hours (6). */
  windowHours?: number;
  /** When the next start becomes available (Unix seconds). */
  resetsAt?: number;
  /** Self said the limit is reached (`limit.code` / the refusal's code). */
  limited?: true;
}

const Count = z.number().int().min(0).max(1000).optional().catch(undefined);
const Max = z.number().int().min(1).max(1000).optional().catch(undefined);
const Hours = z
  .number()
  .positive()
  .max(24 * 31)
  .optional()
  .catch(undefined);
const Seconds = z
  .number()
  .int()
  .min(0)
  .max(31 * 24 * 3600)
  .optional()
  .catch(undefined);

/** The fields as `Starts` keeps them (Unix seconds), for a cached link state. */
export const StartsSchema = z
  .object({
    startsLeft: Count,
    startsMax: Max,
    windowHours: Hours,
    resetsAt: z.number().int().nonnegative().optional().catch(undefined),
    limited: z.literal(true).optional().catch(undefined),
  })
  .transform(compact);

function compact(s: Starts): Starts {
  const out: Starts = {};
  if (s.startsLeft !== undefined) out.startsLeft = s.startsLeft;
  if (s.startsMax !== undefined) out.startsMax = s.startsMax;
  if (s.windowHours !== undefined) out.windowHours = s.windowHours;
  if (s.resetsAt !== undefined) out.resetsAt = s.resetsAt;
  if (s.limited) out.limited = true;
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The start facts in one of Self's answers (a refusal body, a link status, a
 * created link): the top-level fields, else `limit.{code,resetsAt}`. A wait
 * given only in seconds (`retryAfterSeconds`, else the `Retry-After` header)
 * becomes `resetsAt` from `nowMs`, so a kept answer still tells the right
 * time later. Undefined when Self said nothing about starts.
 */
export function startsOf(
  body: unknown,
  nowMs: number,
  retryAfterHeader?: number,
  code?: string,
): Starts | undefined {
  const top = isRecord(body) ? body : {};
  const limit = isRecord(top.limit) ? top.limit : {};
  const resetsAt =
    selfTimeSeconds(top.resetsAt) ?? selfTimeSeconds(limit.resetsAt);
  const after = Seconds.parse(top.retryAfterSeconds) ?? retryAfterHeader;
  const starts = compact({
    startsLeft: Count.parse(top.startsLeft),
    startsMax: Max.parse(top.startsMax),
    windowHours: Hours.parse(top.windowHours),
    resetsAt:
      resetsAt ??
      (after !== undefined ? Math.ceil(nowMs / 1000) + after : undefined),
    ...(code === START_LIMIT_CODE || limit.code === START_LIMIT_CODE
      ? { limited: true as const }
      : {}),
  });
  return Object.keys(starts).length ? starts : undefined;
}

/**
 * The wait in seconds while the limit holds, else null: the limit is reached
 * (`limited`, or `startsLeft` 0) and its reset is still ahead (or unknown).
 * `0` stands for "reached, reset time unknown".
 */
export function limitWait(
  starts: Starts | undefined,
  nowMs: number,
): number | null {
  if (!starts || !(starts.limited || starts.startsLeft === 0)) return null;
  if (starts.resetsAt === undefined) return 0;
  const left = starts.resetsAt - Math.floor(nowMs / 1000);
  return left > 0 ? left : null;
}

const MINUTE = 60;

/**
 * A wait as the person reads it after "You can try again": "in a minute"
 * (only when it is at most a minute), "in a few minutes" (under 5 minutes),
 * "in about 12 minutes" (minutes rounded up; from 15 minutes up to the next
 * 5, so they never come back too early), "in about 5 hours" (from 90 minutes:
 * hours, rounded). `seconds` above 0.
 */
export function friendlyWait(seconds: number): string {
  if (seconds <= MINUTE) return 'in a minute';
  if (seconds < 5 * MINUTE) return 'in a few minutes';
  const minutes = Math.ceil(seconds / MINUTE);
  if (minutes < 15) return `in about ${minutes} minutes`;
  if (seconds < 90 * MINUTE)
    return `in about ${Math.ceil(minutes / 5) * 5} minutes`;
  const hours = Math.round(seconds / 3600);
  return `in about ${hours} hours`;
}

/** "You can try 2 more times." / "You can try 1 more time." */
export function startsLeftSentence(startsLeft: number): string {
  return `You can try ${startsLeft} more ${startsLeft === 1 ? 'time' : 'times'}.`;
}

/**
 * The person's words when no start is left: "You've used your 3 tries for
 * now. You can try again in about 5 hours. Just message me then and I'll send
 * you a new link." Without `startsMax`: "all your tries"; without a known
 * wait (`waitSeconds` 0): "later today".
 */
export function limitSentence(
  starts: Starts | undefined,
  waitSeconds: number,
): string {
  const used =
    starts?.startsMax !== undefined
      ? `You've used your ${starts.startsMax} ${starts.startsMax === 1 ? 'try' : 'tries'} for now.`
      : "You've used all your tries for now.";
  const when = waitSeconds > 0 ? friendlyWait(waitSeconds) : 'later today';
  return `${used} You can try again ${when}. Just message me then and I'll send you a new link.`;
}

/** The structured facts of a reached limit, for the agent (never sent). */
export interface LimitFacts {
  code: typeof START_LIMIT_CODE;
  /** ISO 8601 (UTC), when known. */
  resetsAt?: string;
  /** Seconds left until then, as of this answer, when known. */
  retryAfterSeconds?: number;
  /** The wait in the words the person was told. */
  tryAgain: string;
  startsLeft: 0;
  startsMax?: number;
  windowHours?: number;
}

export function limitFacts(
  starts: Starts | undefined,
  waitSeconds: number,
): LimitFacts {
  return {
    code: START_LIMIT_CODE,
    ...(waitSeconds > 0 && starts?.resetsAt !== undefined
      ? {
          resetsAt: new Date(starts.resetsAt * 1000).toISOString(),
          retryAfterSeconds: waitSeconds,
        }
      : {}),
    tryAgain: waitSeconds > 0 ? friendlyWait(waitSeconds) : 'later today',
    startsLeft: 0,
    ...(starts?.startsMax !== undefined ? { startsMax: starts.startsMax } : {}),
    ...(starts?.windowHours !== undefined
      ? { windowHours: starts.windowHours }
      : {}),
  };
}

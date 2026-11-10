import { z } from 'zod';

/**
 * Times the plugin reads from its services and tells the person.
 *
 * Services answer Unix seconds (the Hub) or ISO 8601 text (Self); both are
 * Unix seconds inside the plugin. The person reads an end as their own
 * local time when the runtime knows their zone, else relative to now ("in
 * 15 minutes"): a chat such as WhatsApp gives no zone, and a time in a zone
 * they do not live in ("06:34 UTC") misleads.
 */

/** ISO 8601 with a zone (`Z` or `±hh:mm`): text without one would read as local time. */
const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * A time from Self: Unix seconds, or the ISO 8601 text Self's contract uses
 * (`2026-11-10T06:27:47.000Z`). Always Unix seconds afterwards.
 */
export const SelfTime = z.union([
  z.number().int().nonnegative(),
  z
    .string()
    .max(40)
    .regex(ISO_8601, 'not an ISO 8601 time')
    .refine((v) => Number.isFinite(Date.parse(v)), 'not a time')
    .transform((v) => Math.floor(Date.parse(v) / 1000)),
]);

/** `raw` as Unix seconds when it is a time {@link SelfTime} accepts, else null. */
export function selfTimeSeconds(raw: unknown): number | null {
  const parsed = SelfTime.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** "14:05" in `timeZone`; null for a zone name the runtime does not know. */
function localTime(unixSeconds: number, timeZone: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone,
    }).format(new Date(unixSeconds * 1000));
  } catch {
    return null;
  }
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * How long until a moment `seconds` ahead, in plain words: "in 15 minutes"
 * (minutes rounded up, so never "in 0 minutes"; a link Self made 15 minutes
 * long reads "in 15 minutes", not 14), "in about 2 hours" (rounded), "in
 * about 3 days" (rounded). `seconds` must be above 0.
 */
export function relativeTime(seconds: number): string {
  const minutes = Math.ceil(seconds / MINUTE);
  if (minutes < 60) return `in ${plural(minutes, 'minute')}`;
  const hours = Math.round(seconds / HOUR);
  if (hours < 24) return `in about ${plural(hours, 'hour')}`;
  return `in about ${plural(Math.max(1, Math.round(seconds / DAY)), 'day')}`;
}

/**
 * When something ends, as the person reads it after "ends": "at 18:05" in
 * their zone when it is known, else "in 15 minutes". Null once it has passed
 * (the caller then words the sentence without an end).
 */
export function whenItEnds(
  unixSeconds: number,
  opts: { timeZone?: string; nowMs: number },
): string | null {
  const left = unixSeconds - opts.nowMs / 1000;
  if (!(left > 0)) return null;
  const local = opts.timeZone ? localTime(unixSeconds, opts.timeZone) : null;
  return local ? `at ${local}` : relativeTime(left);
}

/**
 * Pure scheduling math — next-run computation for the three schedule kinds,
 * validation problems, previews and the failure-backoff curve. No Durable
 * Object involved.
 */
import { CronExpressionParser } from 'cron-parser';
import { describe, expect, it } from 'vitest';
import {
  backoffDelayMs,
  computeNextRunAtMs,
  cronIntervalMs,
  FAILURE_BACKOFF_BASE_MS,
  FAILURE_BACKOFF_MAX_MS,
  previewRuns,
  summarizeSchedule,
  validateSchedule,
} from './schedule';

const T0 = Date.UTC(2026, 0, 15, 6, 30, 0); // 2026-01-15T06:30:00Z

describe('computeNextRunAtMs', () => {
  it('once: returns the moment when it is in the future', () => {
    const at = new Date(T0 + 60_000).toISOString();
    expect(computeNextRunAtMs({ kind: 'once', at }, T0)).toBe(T0 + 60_000);
  });

  it('once: returns null when the moment has passed or does not parse', () => {
    const past = new Date(T0 - 1).toISOString();
    expect(computeNextRunAtMs({ kind: 'once', at: past }, T0)).toBeNull();
    expect(
      computeNextRunAtMs({ kind: 'once', at: 'not-a-date' }, T0),
    ).toBeNull();
  });

  it('cron: returns the next occurrence in the given timezone', () => {
    const next = computeNextRunAtMs(
      { kind: 'cron', cron: '0 7 * * *', timezone: 'UTC' },
      T0,
    );
    expect(next).toBe(Date.UTC(2026, 0, 15, 7, 0, 0));
    // From after 07:00 the next fire is tomorrow.
    const later = computeNextRunAtMs(
      { kind: 'cron', cron: '0 7 * * *', timezone: 'UTC' },
      Date.UTC(2026, 0, 15, 8, 0, 0),
    );
    expect(later).toBe(Date.UTC(2026, 0, 16, 7, 0, 0));
  });

  it('cron: keeps the wall-clock time across a DST change in the timezone', () => {
    const schedule = {
      kind: 'cron' as const,
      cron: '0 9 * * *',
      timezone: 'America/New_York',
    };
    // 09:00 EST is 14:00Z; after the clocks go forward on 8 March 2026,
    // 09:00 EDT is 13:00Z.
    const firstFire = Date.UTC(2026, 2, 7, 14);
    expect(computeNextRunAtMs(schedule, firstFire - 1)).toBe(firstFire);
    expect(computeNextRunAtMs(schedule, firstFire)).toBe(
      Date.UTC(2026, 2, 8, 13),
    );
    // And back on 1 November 2026.
    expect(computeNextRunAtMs(schedule, Date.UTC(2026, 9, 31, 13))).toBe(
      Date.UTC(2026, 10, 1, 14),
    );
  });

  it('cron: skips months without the day and resolves the last day of the month', () => {
    // The 31st after 1 April is 31 May (April has 30 days).
    expect(
      computeNextRunAtMs(
        { kind: 'cron', cron: '0 0 31 * *', timezone: 'UTC' },
        Date.UTC(2026, 3, 1),
      ),
    ).toBe(Date.UTC(2026, 4, 31));
    // `L` is the last day: 28 February in 2026, 29 February in 2028.
    expect(
      computeNextRunAtMs(
        { kind: 'cron', cron: '0 0 L * *', timezone: 'UTC' },
        Date.UTC(2026, 1, 2),
      ),
    ).toBe(Date.UTC(2026, 1, 28));
    expect(
      computeNextRunAtMs(
        { kind: 'cron', cron: '0 0 L * *', timezone: 'UTC' },
        Date.UTC(2028, 1, 2),
      ),
    ).toBe(Date.UTC(2028, 1, 29));
  });

  it('cron: a fire long overdue yields the next FUTURE occurrence, not the missed ones', () => {
    const schedule = {
      kind: 'cron' as const,
      cron: '*/5 * * * *',
      timezone: 'UTC',
    };
    // A week of downtime: the next run is the first slot after now.
    const now = Date.UTC(2026, 0, 22, 6, 31, 10);
    expect(computeNextRunAtMs(schedule, now)).toBe(
      Date.UTC(2026, 0, 22, 6, 35),
    );
  });

  it('cron: returns null for an unparseable pattern', () => {
    expect(
      computeNextRunAtMs({ kind: 'cron', cron: 'definitely not cron' }, T0),
    ).toBeNull();
  });

  it('interval: steps from the reference time', () => {
    expect(
      computeNextRunAtMs({ kind: 'interval', everySeconds: 300 }, T0),
    ).toBe(T0 + 300_000);
    expect(
      computeNextRunAtMs({ kind: 'interval', everySeconds: 0 }, T0),
    ).toBeNull();
  });
});

describe('previewRuns', () => {
  it('returns the next N strictly-increasing occurrences', () => {
    const runs = previewRuns(
      { kind: 'cron', cron: '0 7 * * *', timezone: 'UTC' },
      3,
      T0,
    );
    expect(runs).toEqual([
      new Date(Date.UTC(2026, 0, 15, 7, 0, 0)).toISOString(),
      new Date(Date.UTC(2026, 0, 16, 7, 0, 0)).toISOString(),
      new Date(Date.UTC(2026, 0, 17, 7, 0, 0)).toISOString(),
    ]);
  });

  it('a one-shot yields at most one run', () => {
    const at = new Date(T0 + 60_000).toISOString();
    expect(previewRuns({ kind: 'once', at }, 3, T0)).toEqual([
      new Date(T0 + 60_000).toISOString(),
    ]);
    expect(previewRuns({ kind: 'once', at }, 3, T0 + 120_000)).toEqual([]);
  });

  it('interval yields evenly spaced runs', () => {
    const runs = previewRuns({ kind: 'interval', everySeconds: 600 }, 3, T0);
    expect(runs.map((iso) => Date.parse(iso))).toEqual([
      T0 + 600_000,
      T0 + 1_200_000,
      T0 + 1_800_000,
    ]);
  });
});

describe('validateSchedule', () => {
  it('accepts a sane cron and rejects a too-frequent one', () => {
    expect(
      validateSchedule(
        { kind: 'cron', cron: '0 7 * * *', timezone: 'UTC' },
        300,
        T0,
      ),
    ).toEqual([]);
    const problems = validateSchedule(
      { kind: 'cron', cron: '* * * * *' },
      300,
      T0,
    );
    expect(problems.join(' ')).toMatch(/minimum interval/);
  });

  it('rejects an unparseable cron', () => {
    const problems = validateSchedule({ kind: 'cron', cron: 'nope' }, 300, T0);
    expect(problems.join(' ')).toMatch(/not valid/);
  });

  it('rejects a past or malformed one-shot', () => {
    expect(
      validateSchedule(
        { kind: 'once', at: new Date(T0 - 1000).toISOString() },
        300,
        T0,
      ).join(' '),
    ).toMatch(/in the past/);
    expect(
      validateSchedule({ kind: 'once', at: 'garbage' }, 300, T0).join(' '),
    ).toMatch(/not a valid ISO/);
    expect(
      validateSchedule(
        { kind: 'once', at: new Date(T0 + 1000).toISOString() },
        300,
        T0,
      ),
    ).toEqual([]);
  });

  it('applies the frequency floor to interval schedules', () => {
    expect(
      validateSchedule({ kind: 'interval', everySeconds: 60 }, 300, T0).join(
        ' ',
      ),
    ).toMatch(/below the minimum/);
    expect(
      validateSchedule({ kind: 'interval', everySeconds: 300 }, 300, T0),
    ).toEqual([]);
    expect(
      validateSchedule({ kind: 'interval', everySeconds: 0 }, 300, T0).join(
        ' ',
      ),
    ).toMatch(/positive integer/);
  });
});

describe('cronIntervalMs', () => {
  it('measures the gap between consecutive fires', () => {
    expect(cronIntervalMs('* * * * *')).toBe(60_000);
    expect(cronIntervalMs('bad pattern')).toBeNull();
  });

  it('is the SHORTEST gap of the pattern, not the gap after the reference time', () => {
    // From hh:35 the next two fires are hh+1:00 and hh+1:30 — 30 minutes
    // apart — but :30, :31 … :34 are a minute apart every hour.
    const at35 = Date.UTC(2026, 0, 15, 6, 35);
    expect(cronIntervalMs('0,30-34 * * * *', 'UTC', at35)).toBe(60_000);
    expect(cronIntervalMs('0 7 * * *', 'UTC', T0)).toBe(86_400_000);
    expect(cronIntervalMs('0 9 * * 1', 'UTC', T0)).toBe(7 * 86_400_000);
    // Six-field pattern (seconds).
    expect(cronIntervalMs('*/10 * * * * *', 'UTC', T0)).toBe(10_000);
  });

  it('counts the gap across midnight between two firing days', () => {
    // Mondays and Tuesdays: 23:55 Monday → 00:00 Tuesday is 5 minutes.
    expect(cronIntervalMs('0,55 0,23 * * 1,2', 'UTC', T0)).toBe(300_000);
    // Only Mondays: 23:55 → 00:55 the same day, never across midnight.
    expect(cronIntervalMs('0,55 0,23 * * 1', 'UTC', T0)).toBe(55 * 60_000);
  });

  it('counts month ends: the 31st → the 1st only exists in 31-day months', () => {
    // From February the next fires are 1 March 00:00 and 00:55.
    const feb = Date.UTC(2026, 1, 2);
    expect(cronIntervalMs('0,55 0,23 1,31 * *', 'UTC', feb)).toBe(300_000);
    // The 30th → the 1st is at least a day apart.
    expect(cronIntervalMs('0 0 1,30 * *', 'UTC', feb)).toBe(86_400_000);
  });

  it('measures real elapsed time across a DST change in the task timezone', () => {
    // 01:00 and 04:00 New York are 3 hours apart, except on the day the
    // clocks go forward (8 March 2026): 01:00 EST → 04:00 EDT is 2 hours.
    expect(cronIntervalMs('0 1,4 * * *', 'UTC', T0)).toBe(3 * 3_600_000);
    expect(cronIntervalMs('0 1,4 * * *', 'America/New_York', T0)).toBe(
      2 * 3_600_000,
    );
    // A daily fire never comes closer than 23 hours.
    expect(cronIntervalMs('30 2 * * *', 'America/New_York', T0)).toBe(
      23 * 3_600_000,
    );
  });

  it('examines only the fires around a clock change, not days of them', () => {
    // A 5-minute pattern fires 864 times in three days; the gaps that can
    // shrink at a clock change all lie within about two hours of it.
    for (const timezone of ['America/New_York', 'Europe/London']) {
      const examined = { fires: 0 };
      expect(
        cronIntervalMs('*/5 * * * *', timezone, T0, 300_000, examined),
      ).toBe(300_000);
      // Two changes a year, each well under a day's worth of fires.
      expect(examined.fires).toBeGreaterThan(0);
      expect(examined.fires).toBeLessThan(2 * 100);
    }
  });

  it('around clock changes finds the same shortest gap as walking every fire', () => {
    // Brute force: every fire from two days before to one day after each
    // day on which the zone's UTC offset changes.
    function walked(cron: string, timezone: string): number {
      const format = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        timeZoneName: 'longOffset',
      });
      // The offset part alone: the formatted string also carries the date,
      // which differs every day.
      const offsetAt = (ms: number) =>
        format
          .formatToParts(new Date(ms))
          .find((part) => part.type === 'timeZoneName')?.value;
      let shortest = Number.POSITIVE_INFINITY;
      for (let day = 1; day <= 366; day += 1) {
        const at = T0 + day * 86_400_000;
        if (offsetAt(at) === offsetAt(at - 86_400_000)) continue;
        const fires = CronExpressionParser.parse(cron, {
          currentDate: new Date(at - 2 * 86_400_000),
          tz: timezone,
        });
        let previous: number | undefined;
        for (let n = 0; n < 3_000; n += 1) {
          const fire = fires.next().getTime();
          if (fire > at + 86_400_000) break;
          if (previous !== undefined && fire <= previous) break;
          if (previous !== undefined)
            shortest = Math.min(shortest, fire - previous);
          previous = fire;
        }
      }
      return shortest;
    }
    const patterns = [
      '0 1,4 * * *',
      '30 2 * * *',
      '*/20 * * * *',
      '0,59 1 * * *',
      '15 1,3 * * 0',
      '0 2,3 * * *',
    ];
    const zones = [
      'America/New_York',
      'Europe/London',
      'Australia/Sydney',
      'Australia/Lord_Howe',
    ];
    for (const timezone of zones) {
      for (const cron of patterns) {
        const measured = cronIntervalMs(cron, timezone, T0);
        const clock = cronIntervalMs(cron, undefined, T0);
        expect(measured, `${cron} in ${timezone}`).toBe(
          Math.min(walked(cron, timezone), clock!),
        );
      }
    }
  });

  it('reports a pattern that fires at most once in the scanned span as unbounded', () => {
    expect(cronIntervalMs('0 0 29 2 *', 'UTC', T0)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it('rejects an unknown timezone', () => {
    expect(cronIntervalMs('0 7 * * *', 'Mars/Olympus_Mons', T0)).toBeNull();
  });
});

describe('validateSchedule: irregular cron patterns', () => {
  it('rejects a pattern whose bursts break the floor even when the next two fires do not', () => {
    const at35 = Date.UTC(2026, 0, 15, 6, 35);
    expect(
      validateSchedule(
        { kind: 'cron', cron: '0,30-34 * * * *' },
        300,
        at35,
      ).join(' '),
    ).toMatch(/minimum interval/);
    const at59 = Date.UTC(2026, 0, 15, 6, 59);
    expect(
      validateSchedule(
        { kind: 'cron', cron: '0,10-59 * * * *' },
        300,
        at59,
      ).join(' '),
    ).toMatch(/minimum interval/);
  });

  it('rejects a pattern that only breaks the floor across a DST change', () => {
    const schedule = {
      kind: 'cron' as const,
      cron: '0 1,4 * * *',
      timezone: 'America/New_York',
    };
    expect(validateSchedule(schedule, 2.5 * 3600, T0).join(' ')).toMatch(
      /minimum interval/,
    );
    expect(
      validateSchedule({ ...schedule, timezone: 'UTC' }, 2.5 * 3600, T0),
    ).toEqual([]);
  });

  it('accepts a regular pattern at exactly the floor, in a DST timezone too', () => {
    for (const timezone of ['UTC', 'America/New_York', 'Europe/London']) {
      expect(
        validateSchedule(
          { kind: 'cron', cron: '*/5 * * * *', timezone },
          300,
          T0,
        ),
      ).toEqual([]);
    }
  });
});

describe('backoffDelayMs', () => {
  it('doubles per consecutive failure and caps at the ceiling', () => {
    expect(backoffDelayMs(0)).toBe(0);
    expect(backoffDelayMs(1)).toBe(FAILURE_BACKOFF_BASE_MS);
    expect(backoffDelayMs(2)).toBe(FAILURE_BACKOFF_BASE_MS * 2);
    expect(backoffDelayMs(3)).toBe(FAILURE_BACKOFF_BASE_MS * 4);
    expect(backoffDelayMs(20)).toBe(FAILURE_BACKOFF_MAX_MS);
  });
});

describe('summarizeSchedule', () => {
  it('renders each kind', () => {
    expect(
      summarizeSchedule({ kind: 'once', at: '2026-01-15T07:00:00.000Z' }),
    ).toBe('once at 2026-01-15T07:00:00.000Z');
    expect(
      summarizeSchedule({ kind: 'cron', cron: '0 7 * * *', timezone: 'UTC' }),
    ).toBe('cron `0 7 * * *` (UTC)');
    expect(summarizeSchedule({ kind: 'interval', everySeconds: 900 })).toBe(
      'every 900s',
    );
  });
});

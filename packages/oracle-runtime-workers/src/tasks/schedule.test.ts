/**
 * Pure scheduling math — next-run computation for the three schedule kinds,
 * validation problems, previews and the failure-backoff curve. No Durable
 * Object involved.
 */
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

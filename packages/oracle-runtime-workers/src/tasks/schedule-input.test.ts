import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ScheduleInputSchema,
  ScheduleInputToScheduleSchema,
  toTaskSchedule,
} from './schedule-input';

describe('the flat schedule input (what the model writes)', () => {
  it('converts each kind to the scheduler schedule, ignoring the other kinds’ fields', () => {
    expect(
      toTaskSchedule({ kind: 'once', at: '2026-09-13T10:00:00Z' }),
    ).toEqual({
      ok: true,
      schedule: { kind: 'once', at: '2026-09-13T10:00:00Z' },
    });
    expect(
      toTaskSchedule({
        kind: 'cron',
        cron: '0 7 * * *',
        timezone: 'Asia/Dubai',
      }),
    ).toEqual({
      ok: true,
      schedule: { kind: 'cron', cron: '0 7 * * *', timezone: 'Asia/Dubai' },
    });
    expect(toTaskSchedule({ kind: 'cron', cron: '0 7 * * *' })).toEqual({
      ok: true,
      schedule: { kind: 'cron', cron: '0 7 * * *' },
    });
    expect(toTaskSchedule({ kind: 'interval', everySeconds: 300 })).toEqual({
      ok: true,
      schedule: { kind: 'interval', everySeconds: 300 },
    });
    // A stray field of another kind is one mistake, not a rejection.
    expect(
      toTaskSchedule({
        kind: 'once',
        at: '2026-09-13T10:00:00Z',
        cron: '* * * * *',
      }),
    ).toEqual({
      ok: true,
      schedule: { kind: 'once', at: '2026-09-13T10:00:00Z' },
    });
  });

  it('names the missing field of a kind', () => {
    expect(toTaskSchedule({ kind: 'once' })).toEqual({
      ok: false,
      error: 'schedule.kind "once" needs `at` (ISO timestamp).',
    });
    expect(toTaskSchedule({ kind: 'cron' })).toMatchObject({ ok: false });
    expect(toTaskSchedule({ kind: 'interval' })).toMatchObject({ ok: false });
  });

  it('renders as a flat object with an enum discriminator — no oneOf/const', () => {
    const json = JSON.stringify(z.toJSONSchema(ScheduleInputSchema));
    expect(json).not.toContain('oneOf');
    expect(json).not.toContain('"const"');
    expect(json).toContain('"enum":["once","cron","interval"]');
    expect(json).toContain('"required":["kind"]');
  });

  it('the transform schema yields the scheduler schedule and rejects a bare string or a missing field', () => {
    expect(
      ScheduleInputToScheduleSchema.parse({
        kind: 'interval',
        everySeconds: 60,
      }),
    ).toEqual({ kind: 'interval', everySeconds: 60 });
    expect(
      ScheduleInputToScheduleSchema.safeParse('2026-09-13T10:00:00Z').success,
    ).toBe(false);
    const missing = ScheduleInputToScheduleSchema.safeParse({ kind: 'once' });
    expect(missing.success).toBe(false);
    expect(
      missing.success ? '' : (missing.error.issues[0]?.message ?? ''),
    ).toContain('needs `at`');
    expect(
      ScheduleInputToScheduleSchema.safeParse({ kind: 'daily' }).success,
    ).toBe(false);
  });
});

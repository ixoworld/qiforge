/**
 * The schedule as the MODEL writes it: one flat object with a `kind` enum
 * and the per-kind fields optional, refined to `OracleTaskSchedule`.
 *
 * `TaskScheduleSchema` (spec.ts) is a discriminated union — the right shape
 * for the store and the spec frontmatter, but LangChain renders it as JSON
 * schema `oneOf` + `const`, and Gemini 3.5 Flash answers that shape with a
 * bare ISO string for `schedule` (5/5 probes through OpenRouter with the
 * runtime's exact kwargs). A flat object with an `enum` discriminator is
 * honoured by every provider probed (Gemini 2/2, GPT-5.6 2/2), so the tool
 * boundary uses this and converts; nothing downstream changes.
 */
import { z } from 'zod';
import type { OracleTaskSchedule } from '../plugin-api/types';

const SCHEDULE_DESCRIPTION =
  'When the task fires. kind "once" needs `at` (ISO timestamp, computed from the current time — ALWAYS use it for one-time requests such as "in 10 minutes" or "tomorrow at 5pm"); kind "cron" needs `cron` (+ optional IANA `timezone`) and is ONLY for genuinely recurring intents — `*/10 * * * *` means every 10 minutes forever, not once in 10 minutes; kind "interval" needs `everySeconds`. Leave the other kinds\' fields out.';

export const ScheduleInputSchema = z
  .object({
    kind: z.enum(['once', 'cron', 'interval']),
    at: z
      .string()
      .min(1)
      .optional()
      .describe('ISO timestamp — kind "once" only.'),
    cron: z
      .string()
      .min(1)
      .optional()
      .describe('Cron expression (5 fields) — kind "cron" only.'),
    timezone: z
      .string()
      .min(1)
      .optional()
      .describe('IANA timezone for the cron expression — kind "cron" only.'),
    everySeconds: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Seconds between runs — kind "interval" only.'),
  })
  .describe(SCHEDULE_DESCRIPTION);

export type ScheduleInput = z.infer<typeof ScheduleInputSchema>;

/**
 * The flat input as the scheduler's schedule, or a message naming what is
 * missing. Fields of the other kinds are ignored, not rejected: a model that
 * fills `cron` for a "once" schedule made one mistake, not two.
 */
export function toTaskSchedule(
  input: ScheduleInput,
): { ok: true; schedule: OracleTaskSchedule } | { ok: false; error: string } {
  switch (input.kind) {
    case 'once':
      if (!input.at)
        return {
          ok: false,
          error: 'schedule.kind "once" needs `at` (ISO timestamp).',
        };
      return { ok: true, schedule: { kind: 'once', at: input.at } };
    case 'cron':
      if (!input.cron)
        return {
          ok: false,
          error: 'schedule.kind "cron" needs `cron` (a cron expression).',
        };
      return {
        ok: true,
        schedule: {
          kind: 'cron',
          cron: input.cron,
          ...(input.timezone ? { timezone: input.timezone } : {}),
        },
      };
    case 'interval':
      if (input.everySeconds === undefined)
        return {
          ok: false,
          error:
            'schedule.kind "interval" needs `everySeconds` (a positive integer).',
        };
      return {
        ok: true,
        schedule: { kind: 'interval', everySeconds: input.everySeconds },
      };
  }
}

/** A zod schema that accepts the flat input and yields `OracleTaskSchedule`. */
export const ScheduleInputToScheduleSchema = ScheduleInputSchema.transform(
  (input, ctx) => {
    const converted = toTaskSchedule(input);
    if (!converted.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: converted.error });
      return z.NEVER;
    }
    return converted.schedule;
  },
);

import { z } from 'zod';

export const TriggerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('time.once'),
    runAtIso: z.string().datetime(),
    tz: z.string(),
  }),
  z.object({
    type: z.literal('time.cron'),
    pattern: z.string().min(1),
    tz: z.string(),
  }),
]);

export type Trigger = z.infer<typeof TriggerSchema>;

export function summarizeTrigger(trigger: Trigger): string {
  if (trigger.type === 'time.once') {
    return `once at ${trigger.runAtIso} (${trigger.tz})`;
  }
  return `cron \`${trigger.pattern}\` (${trigger.tz})`;
}

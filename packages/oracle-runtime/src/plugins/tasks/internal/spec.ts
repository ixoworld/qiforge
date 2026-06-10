import { createHash, randomBytes } from 'node:crypto';
import matter from 'gray-matter';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

export const TriggerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('time.once'),
    runAtIso: z.string().datetime(),
    tz: z.string().min(1),
  }),
  z.object({
    type: z.literal('time.cron'),
    pattern: z.string().min(1),
    tz: z.string().min(1),
  }),
]);

export type Trigger = z.infer<typeof TriggerSchema>;

export function summarizeTrigger(trigger: Trigger): string {
  return trigger.type === 'time.once'
    ? `once at ${trigger.runAtIso} (${trigger.tz})`
    : `cron \`${trigger.pattern}\` (${trigger.tz})`;
}

// ---------------------------------------------------------------------------
// TaskSpec — YAML frontmatter + markdown body. The markdown IS the task.
// ---------------------------------------------------------------------------

export const TASK_STATUSES = [
  'active',
  'paused',
  'failed-pending-review',
  'completed',
  'cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TaskFrontmatterSchema = z.object({
  id: z.string().regex(/^task_[a-f0-9]{12}$/),
  owner: z.string().min(1),
  title: z.string().min(1).max(120),
  trigger: TriggerSchema,
  delivery: z.object({
    /** `'main'` = the user's main oracle room, resolved at delivery time. */
    roomId: z.union([z.literal('main'), z.string().min(1)]),
  }),
  approval: z.enum(['never', 'before-delivery']).default('never'),
  status: z.enum(TASK_STATUSES).default('active'),
  stats: z.object({ nextRunAt: z.string().datetime().nullable() }),
});

export type TaskFrontmatter = z.infer<typeof TaskFrontmatterSchema>;

export interface TaskSpec {
  frontmatter: TaskFrontmatter;
  body: string;
}

export function newTaskId(): string {
  return `task_${randomBytes(6).toString('hex')}`;
}

export function userTasksPrefix(owner: string): string {
  return `/users/${owner}/tasks/`;
}

export function specPath(owner: string, taskId: string): string {
  return `${userTasksPrefix(owner)}${taskId}/spec.md`;
}

export function parseSpec(markdown: string): TaskSpec {
  const parsed = matter(markdown);
  return {
    frontmatter: TaskFrontmatterSchema.parse(parsed.data),
    body: parsed.content.trim(),
  };
}

export function renderSpec(spec: TaskSpec): string {
  return matter.stringify(`${spec.body}\n`, spec.frontmatter);
}

// ---------------------------------------------------------------------------
// Intent — the three optional `##` sections the agent fills in.
// ---------------------------------------------------------------------------

export const IntentSchema = z.object({
  whatToDo: z.string().min(1),
  howToReport: z.string().optional(),
  constraints: z.array(z.string()).optional(),
});

export type Intent = z.infer<typeof IntentSchema>;

export function renderIntentBody(intent: Intent): string {
  const parts = ['## What to do', intent.whatToDo.trim()];
  if (intent.howToReport?.trim()) {
    parts.push('', '## How to report', intent.howToReport.trim());
  }
  if (intent.constraints?.length) {
    parts.push(
      '',
      '## Constraints',
      ...intent.constraints.map((c) => `- ${c}`),
    );
  }
  return parts.join('\n');
}

/**
 * Hash of the parts of a spec a preview ran against. `create_task` requires
 * a preview whose hash matches what's being committed — editing the spec
 * after preview forces a re-preview.
 */
export function specHash(title: string, body: string): string {
  return createHash('sha256')
    .update(`${title}\n${body}`)
    .digest('hex')
    .slice(0, 16);
}

import { createHash, randomBytes } from 'node:crypto';
import matter from 'gray-matter';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

export const TriggerSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('time.once'),
      runAtIso: z.string().datetime(),
      tz: z.string().min(1),
    })
    .describe(
      'A single future moment. ALWAYS use this for one-time requests — "in 10 minutes", "after an hour", "tomorrow at 5pm" — computing runAtIso from the current time. Never express a one-time request as cron.',
    ),
  z
    .object({
      type: z.literal('time.cron'),
      pattern: z.string().min(1),
      tz: z.string().min(1),
    })
    .describe(
      'A repeating schedule, ONLY for genuinely recurring intents ("every morning at 7"). Note `*/10 * * * *` means "every 10 minutes forever", NOT "once in 10 minutes" — use time.once for that.',
    ),
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
  'pending-approval',
  'paused',
  'failed-pending-review',
  'completed',
  'cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TaskFrontmatterSchema = z.object({
  id: z.string().regex(/^task_[a-z0-9][a-z0-9-]*_[a-f0-9]{8}$/),
  owner: z.string().min(1),
  title: z.string().min(1).max(120),
  trigger: TriggerSchema,
  delivery: z.object({
    /** `'main'` = the user's main oracle room, resolved at delivery time. */
    roomId: z.union([z.literal('main'), z.string().min(1)]),
  }),
  approval: z.enum(['never', 'before-action']).default('never'),
  status: z.enum(TASK_STATUSES).default('active'),
  stats: z.object({ nextRunAt: z.string().datetime().nullable() }),
});

export type TaskFrontmatter = z.infer<typeof TaskFrontmatterSchema>;

export interface TaskSpec {
  frontmatter: TaskFrontmatter;
  body: string;
}

/**
 * Self-describing id: `task_<title-slug>_<hex>`. Strictly colon-free — task
 * ids are embedded in BullMQ job ids, and BullMQ rejects custom job ids
 * containing `:`.
 */
export function newTaskId(title: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'untitled';
  return `task_${slug}_${randomBytes(4).toString('hex')}`;
}

export function userTasksPrefix(owner: string): string {
  return `/users/${owner}/tasks/`;
}

export function specPath(owner: string, taskId: string): string {
  return `${userTasksPrefix(owner)}${taskId}/spec.md`;
}

export function parseSpec(markdown: string): TaskSpec {
  const parsed = matter(markdown);
  // Legacy alias: specs written before the conversational approval model used
  // `before-delivery`. Map it on read so existing tasks stay parseable; the
  // next save persists the current value.
  const data: Record<string, unknown> =
    typeof parsed.data === 'object' && parsed.data !== null
      ? { ...parsed.data }
      : {};
  if (data.approval === 'before-delivery') data.approval = 'before-action';
  return {
    frontmatter: TaskFrontmatterSchema.parse(data),
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
  context: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Everything a run needs that lives only in this conversation: IDs (team/project UUIDs, entity DIDs), URLs, names, account references. Scheduled runs are FRESH sessions with no memory of this chat — anything not written here does not exist for the run.',
    ),
  requiresApproval: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The exact action that must NOT be performed without the user\'s sign-off, e.g. "publishing the post to LinkedIn". Required when approval is before-action.',
    ),
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
  if (intent.context?.trim()) {
    parts.push('', '## Context', intent.context.trim());
  }
  if (intent.requiresApproval?.trim()) {
    parts.push('', '## Requires approval', intent.requiresApproval.trim());
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

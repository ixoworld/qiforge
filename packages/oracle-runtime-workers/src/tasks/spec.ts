/**
 * Task spec markdown — the user-readable artifact each task is stored as.
 *
 * A spec is YAML frontmatter (identity + trigger + lifecycle) over a markdown
 * body (the intent — what the agent should do each run), rendered and parsed
 * with gray-matter exactly like the Node runtime's `spec.md` files. The
 * Workers store keeps the spec as a column in the user's own SQLite file next
 * to the queryable index columns, so the owner file stays self-describing and
 * portable.
 */
import matter from 'gray-matter';
import { z } from 'zod';
import type { OracleTaskRecord, OracleTaskSchedule } from '../plugin-api/types';

/** Self-describing task id: `task_<title-slug>_<8 hex>`. */
export const TASK_ID_PATTERN = /^task_[a-z0-9][a-z0-9-]*_[a-f0-9]{8}$/;

export function newTaskId(title: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'untitled';
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
  return `task_${slug}_${hex}`;
}

/**
 * Zod schema for `OracleTaskSchedule` — shared by the spec frontmatter, the
 * store's `schedule_json` column and the plugin's tool inputs so all three
 * accept exactly the same shape.
 */
export const TaskScheduleSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('once'),
      at: z.string().min(1),
    })
    .describe(
      'A single future moment (ISO timestamp). ALWAYS use this for one-time requests — "in 10 minutes", "tomorrow at 5pm" — computing `at` from the current time. Never express a one-time request as cron.',
    ),
  z
    .object({
      kind: z.literal('cron'),
      cron: z.string().min(1),
      timezone: z.string().min(1).optional(),
    })
    .describe(
      'A repeating cron schedule, ONLY for genuinely recurring intents ("every morning at 7"). Note `*/10 * * * *` means "every 10 minutes forever", NOT "once in 10 minutes" — use kind "once" for that.',
    ),
  z
    .object({
      kind: z.literal('interval'),
      everySeconds: z.number().int().positive(),
    })
    .describe(
      'Repeat every N seconds from the previous run. For simple fixed cadences that do not need cron precision.',
    ),
]);

export const TASK_STATUSES = [
  'active',
  'paused',
  'completed',
  'cancelled',
  'failed',
] as const;

export const TASK_APPROVALS = ['never', 'before-action'] as const;

const SpecFrontmatterSchema = z.object({
  id: z.string().regex(TASK_ID_PATTERN),
  title: z.string().min(1).max(120),
  schedule: TaskScheduleSchema,
  approval: z.enum(TASK_APPROVALS),
  status: z.enum(TASK_STATUSES),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type TaskSpecFrontmatter = z.infer<typeof SpecFrontmatterSchema>;

export interface ParsedTaskSpec {
  frontmatter: TaskSpecFrontmatter;
  intent: string;
}

/** JSON round-trip: YAML cannot serialise `undefined` values (`timezone?`). */
function toPlainSchedule(schedule: OracleTaskSchedule): OracleTaskSchedule {
  return JSON.parse(JSON.stringify(schedule)) as OracleTaskSchedule;
}

/** Render a task record as its spec markdown (frontmatter + intent body). */
export function renderTaskSpec(record: OracleTaskRecord): string {
  const frontmatter: TaskSpecFrontmatter = {
    id: record.id,
    title: record.title,
    schedule: toPlainSchedule(record.schedule),
    approval: record.approval,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  return matter.stringify(`${record.intent.trim()}\n`, frontmatter);
}

/** Parse a spec markdown back into frontmatter + intent. Throws on schema drift. */
export function parseTaskSpec(markdown: string): ParsedTaskSpec {
  const parsed = matter(markdown);
  const data: unknown = parsed.data;
  return {
    frontmatter: SpecFrontmatterSchema.parse(data),
    intent: parsed.content.trim(),
  };
}

/** The intent body of a spec without validating the frontmatter. */
export function specIntentOf(markdown: string): string {
  return matter(markdown).content.trim();
}

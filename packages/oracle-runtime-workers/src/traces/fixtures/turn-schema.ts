/**
 * TEST ONLY (not published: `src/**\/fixtures/` is outside the package files).
 *
 * A verbatim copy of the IXO Traces ingest validation
 * (`ixoworld/ixo-langsmith-traces`, `src/contracts/turn.ts` as of its
 * foundation merge 5854c86, and `parseTimestamp` from `src/lib/time.ts`), so
 * the tracer's tests check its output against the schema the service runs.
 * Only the import of `parseTimestamp` was inlined.
 */
import { z } from 'zod';
import { TURN_LIMITS, RUN_TYPES } from '../contract';

export function parseTimestamp(v: unknown): number | null {
  if (typeof v === 'number')
    return Number.isFinite(v) && v >= 0 && v < 8.64e15 ? Math.floor(v) : null;
  if (typeof v !== 'string') return null;
  if (/^\d{10,16}$/.test(v)) return parseTimestamp(Number(v));
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.test(
      v,
    )
  )
    return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

const TURN_STATUSES = ['success', 'error', 'interrupted'] as const;

const isoTime = z
  .string()
  .max(40)
  .refine(
    (s) => parseTimestamp(s) !== null,
    'must be an ISO 8601 timestamp with a zone, e.g. 2026-11-24T10:00:00.000Z',
  );

const uuid = z
  .string()
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    'must be a UUID',
  )
  .transform((s) => s.toLowerCase());

const idString = z
  .string()
  .min(1)
  .max(TURN_LIMITS.maxIdLength)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f\u007f]+$/, 'must not contain control characters');

const nonNegative = z.number().min(0);

const metadataSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(TURN_LIMITS.maxMetadataKeyLength)
      .regex(/^[A-Za-z0-9_.:-]+$/, 'metadata keys are [A-Za-z0-9_.:-]'),
    z.string().max(TURN_LIMITS.maxMetadataValueLength),
  )
  .refine(
    (m) => Object.keys(m).length <= TURN_LIMITS.maxMetadataKeys,
    `at most ${TURN_LIMITS.maxMetadataKeys} keys`,
  );

const tagsSchema = z
  .array(z.string().min(1).max(TURN_LIMITS.maxTagLength))
  .max(TURN_LIMITS.maxTags);

const jsonObject = z.record(z.string(), z.unknown());

export const RunSchema = z
  .object({
    id: uuid,
    trace_id: uuid.optional(),
    parent_run_id: uuid.nullable(),
    dotted_order: z.string().min(1).max(TURN_LIMITS.maxDottedOrderLength),
    name: z.string().min(1).max(TURN_LIMITS.maxNameLength),
    run_type: z.enum(RUN_TYPES),
    start_time: isoTime,
    end_time: isoTime.nullable(),
    status: z.enum(['success', 'error', 'pending']).optional(),
    inputs: jsonObject.nullable().optional(),
    outputs: jsonObject.nullable().optional(),
    error: z.string().max(TURN_LIMITS.maxErrorLength).nullable().optional(),
    extra: jsonObject.nullable().optional(),
    tags: tagsSchema.optional(),
    events: z.array(jsonObject).max(TURN_LIMITS.maxEventsPerRun).optional(),
    serialized: jsonObject.nullable().optional(),
    prompt_tokens: nonNegative.optional(),
    completion_tokens: nonNegative.optional(),
    total_tokens: nonNegative.optional(),
    prompt_cost: nonNegative.optional(),
    completion_cost: nonNegative.optional(),
    total_cost: nonNegative.optional(),
    first_token_time: isoTime.nullable().optional(),
  })
  .loose();

export const UsageSchema = z
  .object({
    input_tokens: nonNegative.default(0),
    cached_tokens: nonNegative.default(0),
    output_tokens: nonNegative.default(0),
    cost_usd: nonNegative.default(0),
  })
  .strict();

export const TurnSchema = z
  .object({
    v: z.literal(1),
    trace_id: uuid,
    thread_id: idString,
    user_id: idString,
    start_time: isoTime,
    end_time: isoTime,
    status: z.enum(TURN_STATUSES),
    error: z.string().max(TURN_LIMITS.maxErrorLength).nullable().default(null),
    name: z.string().min(1).max(TURN_LIMITS.maxNameLength),
    metadata: metadataSchema.default({}),
    tags: tagsSchema.default([]),
    usage: UsageSchema.default({
      input_tokens: 0,
      cached_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
    }),
    user_text: z
      .string()
      .max(TURN_LIMITS.maxPreviewTextLength)
      .nullable()
      .default(null),
    reply_text: z
      .string()
      .max(TURN_LIMITS.maxPreviewTextLength)
      .nullable()
      .default(null),
    runs: z.array(RunSchema).min(1).max(TURN_LIMITS.maxRuns),
  })
  .strict()
  .superRefine((t, ctx) => {
    const start = parseTimestamp(t.start_time) ?? 0;
    const end = parseTimestamp(t.end_time) ?? 0;
    if (end < start)
      ctx.addIssue({
        code: 'custom',
        path: ['end_time'],
        message: 'end_time is before start_time',
      });
    if (t.status === 'error' && !t.error) {
      ctx.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'status error needs an error string',
      });
    }
    const ids = new Set<string>();
    let roots = 0;
    for (const [i, r] of t.runs.entries()) {
      if (ids.has(r.id))
        ctx.addIssue({
          code: 'custom',
          path: ['runs', i, 'id'],
          message: 'duplicate run id',
        });
      ids.add(r.id);
      if (r.trace_id !== undefined && r.trace_id !== t.trace_id) {
        ctx.addIssue({
          code: 'custom',
          path: ['runs', i, 'trace_id'],
          message: 'run trace_id differs from turn trace_id',
        });
      }
      if (r.parent_run_id === null) {
        roots++;
        if (r.id !== t.trace_id) {
          ctx.addIssue({
            code: 'custom',
            path: ['runs', i, 'id'],
            message: 'the root run id must equal trace_id',
          });
        }
      }
    }
    if (roots !== 1)
      ctx.addIssue({
        code: 'custom',
        path: ['runs'],
        message: 'exactly one root run (parent_run_id null)',
      });
    for (const [i, r] of t.runs.entries()) {
      if (r.parent_run_id !== null && !ids.has(r.parent_run_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['runs', i, 'parent_run_id'],
          message: 'parent run is not in this turn',
        });
      }
    }
  });

export const TurnStartSchema = z
  .object({
    v: z.literal(1),
    trace_id: uuid,
    thread_id: idString,
    user_id: idString,
    start_time: isoTime,
    name: z.string().min(1).max(TURN_LIMITS.maxNameLength),
  })
  .strict();

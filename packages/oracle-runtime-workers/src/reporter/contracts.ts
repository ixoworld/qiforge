import { z } from 'zod';

export const REPORTER_VALUE_BYTES = 64 * 1024;
export const REPORTER_PAGE_BYTES = 256 * 1024 - 1024;
export const REPORTER_RUN_BYTES = 192 * 1024 - 2048;
export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().max(4096);
export const factSchema = z.strictObject({
  nodeId: text.min(1),
  property: text.min(1),
  value: text,
  unit: text.nullable(),
});
const referenceSchema = factSchema.pick({ nodeId: true, property: true });
export const snapshotSchema = z
  .strictObject({
    version: z.literal(1),
    digest: digestSchema,
    certificateDigest: digestSchema,
    capturedAt: z.iso.datetime(),
    title: text.min(1),
    facts: z.array(factSchema).max(1000),
    checks: z
      .array(
        z.strictObject({
          id: text.min(1),
          status: z.enum([
            'running',
            'passed',
            'failed',
            'incomplete',
            'unsupported',
            'access_required',
            'not_checked',
          ]),
        }),
      )
      .max(200),
    disclaimer: text.min(1),
  })
  .refine(
    (value) => jsonBytes(value) <= REPORTER_VALUE_BYTES,
    'Snapshot exceeds 64 KiB',
  );
export const narrativeSchema = z.strictObject({
  version: z.literal(1),
  snapshotDigest: digestSchema,
  sections: z
    .array(
      z.strictObject({
        topic: z.enum([
          'why',
          'what',
          'who',
          'where',
          'when',
          'how-much',
          'explanation',
        ]),
        units: z
          .array(
            z.discriminatedUnion('kind', [
              factSchema.extend({ kind: z.literal('fact') }),
              z.strictObject({
                kind: z.literal('interpretation'),
                text: text.min(1),
                refs: z.array(referenceSchema).min(1).max(30),
              }),
              z.strictObject({
                kind: z.literal('missing'),
                text: z.literal('This information is not recorded'),
              }),
            ]),
          )
          .min(1)
          .max(50),
      }),
    )
    .min(1)
    .max(20),
});
export const boundedNarrativeSchema = narrativeSchema.refine(
  (value) => jsonBytes(value) <= REPORTER_VALUE_BYTES,
  'Narrative exceeds 64 KiB',
);
export const sessionBodySchema = z.strictObject({
  version: z.literal(1),
  requestId: z.uuid(),
  snapshot: snapshotSchema,
});
export const turnBodySchema = z.strictObject({
  version: z.literal(1),
  requestId: z.uuid(),
  message: text.min(1),
  model: z.string().min(1).max(200),
  funding: z.enum(['byo_only', 'platform_credits']),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Narrative = z.infer<typeof narrativeSchema>;
export type TurnBody = z.infer<typeof turnBodySchema>;
export const skillReceiptSchema = z.strictObject({
  id: text.min(1),
  version: text.min(1),
  contentHash: digestSchema,
  inputDigest: digestSchema,
  outputDigest: digestSchema,
});
export const executionReceiptSchema = z.strictObject({
  requestedModel: text.min(1),
  actualModel: text.min(1),
  provider: text.min(1),
  funding: z.literal('byo_only'),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  settlement: z.literal('not_applicable'),
});
export const historyTurnSchema = z.strictObject({
  message: text.min(1),
  narrative: boundedNarrativeSchema,
});
export const historySchema = z
  .array(historyTurnSchema)
  .max(8)
  .refine(
    (value) => jsonBytes(value) <= REPORTER_VALUE_BYTES,
    'History exceeds 64 KiB',
  );
export const runSchema = z
  .strictObject({
    version: z.literal(1),
    message: text.min(1),
    history: historySchema,
    requestId: z.uuid(),
    runId: z.uuid(),
    sessionId: z.uuid(),
    snapshotDigest: digestSchema,
    status: z.enum(['pending', 'running', 'completed', 'failed', 'uncertain']),
    narrative: boundedNarrativeSchema.optional(),
    skill: skillReceiptSchema.optional(),
    execution: executionReceiptSchema.optional(),
    error: z.string().min(1).max(512).optional(),
  })
  .refine(
    (run) =>
      run.status !== 'completed' ||
      Boolean(run.narrative && run.skill && run.execution),
    'Completed run requires narrative and receipts',
  )
  .refine(
    (run) => Boolean(run.skill) === Boolean(run.execution),
    'Receipts must be paired',
  )
  .refine(
    (run) => !run.narrative || run.status === 'completed',
    'Only completed runs have a narrative',
  )
  .refine(
    (run) => !run.skill || !['pending', 'running'].includes(run.status),
    'Active runs cannot have receipts',
  )
  .refine(
    (run) => jsonBytes(run) <= REPORTER_RUN_BYTES,
    'Run exceeds byte limit',
  );
export const sessionPageSchema = z
  .strictObject({
    version: z.literal(1),
    sessionId: z.uuid(),
    snapshot: snapshotSchema,
    runs: z.array(runSchema).max(50),
    nextCursor: z.uuid().nullable(),
  })
  .refine(
    (page) => jsonBytes(page) <= REPORTER_PAGE_BYTES,
    'Session page exceeds byte limit',
  );
export type SkillReceipt = z.infer<typeof skillReceiptSchema>;
export type ExecutionReceipt = z.infer<typeof executionReceiptSchema>;
export type HistoryTurn = z.infer<typeof historyTurnSchema>;
export type ReporterRun = z.infer<typeof runSchema>;
export class ReporterError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('Invalid canonical JSON');
  return result;
}
export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
export async function validateSnapshot(value: Snapshot): Promise<void> {
  const { digest, ...body } = value;
  if ((await sha256(canonical(body))) !== digest)
    throw new ReporterError(400, 'Snapshot digest mismatch');
  const keys = new Set(
    value.facts.map((f) => canonical([f.nodeId, f.property])),
  );
  if (keys.size !== value.facts.length)
    throw new ReporterError(400, 'Duplicate source reference');
}
export function validateNarrative(
  value: unknown,
  snapshot: Snapshot,
): Narrative {
  const narrative = boundedNarrativeSchema.parse(value);
  if (narrative.snapshotDigest !== snapshot.digest)
    throw new Error('Narrative source mismatch');
  for (const section of narrative.sections)
    for (const unit of section.units) {
      if (
        unit.kind === 'fact' &&
        !snapshot.facts.some(
          (f) =>
            f.nodeId === unit.nodeId &&
            f.property === unit.property &&
            f.value === unit.value &&
            f.unit === unit.unit,
        )
      )
        throw new Error('Narrative fact mismatch');
      if (
        unit.kind === 'interpretation' &&
        unit.refs.some(
          (r) =>
            !snapshot.facts.some(
              (f) => f.nodeId === r.nodeId && f.property === r.property,
            ),
        )
      )
        throw new Error('Narrative reference mismatch');
    }
  return narrative;
}

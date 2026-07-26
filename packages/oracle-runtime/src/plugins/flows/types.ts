/**
 * The FlowSpec model — the friendly, leak-proof projection of the editor's
 * `BaseUcanFlow` that the agent operates on. No tool I/O ever mentions a
 * block, Y.Doc, `can`/`with`, CAR/CID, delegation, or `nb`; the agent thinks
 * in steps / actions / inputs / conditions / schedules / forms.
 *
 * `translator.ts` owns the FlowSpec <-> BaseUcanFlow projection. These zod
 * schemas are the contract for every tool's input; the read path returns the
 * same shape augmented with a read-only `status`.
 */
import { z } from 'zod';

/**
 * Condition operators, aligned 1:1 with the FE condition evaluator's
 * vocabulary (see translator's CONDITION_OP_TO_EVALUATOR). We deliberately do
 * NOT expose the compiler's `eq`/`neq`/... vocabulary — those never evaluate
 * because no normalizer maps them to the evaluator's strings.
 */
export const CONDITION_OPERATORS = [
  'equals',
  'notEquals',
  'greaterThan',
  'lessThan',
  'contains',
  'isEmpty',
  'isNotEmpty',
] as const;

export const conditionSchema = z.object({
  fromStep: z
    .string()
    .describe('Id of the upstream step whose value is checked.'),
  field: z.string().describe('Field on the upstream step to inspect.'),
  is: z.enum(CONDITION_OPERATORS).describe('Comparison operator.'),
  value: z
    .unknown()
    .optional()
    .describe('Value to compare against (omit for isEmpty/isNotEmpty).'),
});

export const hookSchema = z.object({
  type: z.enum(['sendEmail', 'addLinkedEntity', 'sendMatrixDM']),
  config: z.record(z.string(), z.unknown()),
});

export const dueSchema = z.object({
  at: z.string().optional().describe('Absolute due date (ISO 8601).'),
  within: z
    .string()
    .optional()
    .describe(
      'Duration from when the step becomes active (ISO 8601 duration).',
    ),
  afterCommitment: z
    .string()
    .optional()
    .describe('Duration from commitment (ISO 8601 duration).'),
});

export const onEventSchema = z.object({
  fromStep: z.string().describe('Upstream step that emits the event.'),
  event: z.string().describe('Event name the upstream step emits.'),
});

/**
 * A single step the agent authors. Mirrors FlowStep in the spec (§2.1). The
 * read-only `status` is intentionally absent here — agents never write it; it
 * is only attached on read (see FlowStepRead).
 */
export const flowStepSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe('Stable, human-readable step id, e.g. "load-batches".'),
  action: z
    .string()
    .min(1)
    .describe('Action name from list_actions (e.g. "qi/email.send").'),
  title: z.string().optional(),
  description: z.string().optional(),
  phase: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Stable semantic group for this step, such as "discovery" or "deployment".',
    ),
  execution: z
    .enum(['human-only', 'agent-capable'])
    .optional()
    .describe(
      'Whether only a person may run this step or a suitably skilled, authorised Flow Agent may run it.',
    ),

  inputs: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Inputs for the action. A value may be a reference to an upstream output, written as "{{step-id.output.field}}".',
    ),
  form: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'For human form steps: pre-filled answers keyed by question name. Pre-fill only — the user submits in the portal.',
    ),

  after: z
    .array(z.string())
    .optional()
    .describe(
      'Order this step after the named steps. Pair with an input reference for a real data dependency. This is ordering only, not an auto-trigger.',
    ),
  runWhen: conditionSchema
    .optional()
    .describe(
      'Gate this step on an upstream value (static configuration only).',
    ),
  conditions: z
    .array(conditionSchema)
    .optional()
    .describe('Multiple activation gates (all must pass).'),
  onEvent: onEventSchema
    .optional()
    .describe(
      'Advanced: auto-trigger this step when an upstream step emits an event. Only valid for event-capable upstream actions; validate_flow enforces this.',
    ),

  trigger: z
    .enum(['manual', 'flow-start'])
    .optional()
    .describe('When the step runs. Default "manual".'),
  due: dueSchema.optional(),

  assignTo: z
    .string()
    .optional()
    .describe('Assignee (a DID or known alias) — metadata only.'),
  commitTo: z
    .string()
    .optional()
    .describe('Commitment window (ISO 8601 duration).'),

  on: z
    .record(z.string(), z.array(hookSchema))
    .optional()
    .describe('Lifecycle hooks: event name -> hooks.'),
  skills: z
    .array(z.string())
    .optional()
    .describe(
      'Governed skill ids required for agent-capable execution. The first is used for Flow Agent matching.',
    ),
  requireConfirmation: z
    .boolean()
    .optional()
    .describe('Hint the portal to force a confirmation before this step runs.'),
});

/**
 * A whole flow as the agent authors it. `ref` is the opaque flow handle; it is
 * omitted on create and assigned by the plugin.
 */
export const flowSpecSchema = z.object({
  ref: z
    .string()
    .optional()
    .describe('Opaque flow handle. Omit when creating; the plugin assigns it.'),
  title: z.string().min(1),
  goal: z.string().optional(),
  steps: z.array(flowStepSchema),
});

export type Condition = z.infer<typeof conditionSchema>;
export type HookSpec = z.infer<typeof hookSchema>;
export type FlowStep = z.infer<typeof flowStepSchema>;
export type FlowSpecInput = z.infer<typeof flowSpecSchema>;

/** Lifecycle state of a step, read from the runtime map. */
export type StepState =
  | 'idle'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'awaiting_readback';

/**
 * Read-only status derived from the runtime map (§2.6). `state`/`error`/
 * `lastRunAt` are stored; `blockedBy`/`stale` are computed on read.
 */
export interface StepStatus {
  state: StepState;
  error?: { message: string; code?: string; at?: number };
  lastRunAt?: number;
  /** Upstream step ids that are failed or whose output this step still needs. */
  blockedBy?: string[];
  /** Completed but missing its expected proof (e.g. a transaction hash / claim id). */
  stale?: boolean;
}

/** A step as returned by read tools: the authored shape plus its read-only status. */
export type FlowStepRead = FlowStep & { status?: StepStatus };

/** A flow as returned by read tools. */
export interface FlowSpecRead {
  ref: string;
  title: string;
  goal?: string;
  steps: FlowStepRead[];
}

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
import {
  MAX_CONDITIONS_PER_STEP,
  MAX_DESCRIPTION_CHARS,
  MAX_DID_CHARS,
  MAX_FLOW_SPEC_BYTES,
  MAX_FLOW_STEPS,
  MAX_NAME_CHARS,
  MAX_SKILLS_PER_STEP,
  MAX_STEP_ID_CHARS,
  MAX_STEP_INPUTS,
  MAX_STEP_INPUTS_BYTES,
  MAX_STEP_SPEC_BYTES,
  jsonByteLength,
  secretLiteralMessage,
  secretLiteralPaths,
} from './input-policy';

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

const nameSchema = z
  .string()
  .max(MAX_NAME_CHARS, `At most ${MAX_NAME_CHARS} characters.`);
const descriptionSchema = z
  .string()
  .max(MAX_DESCRIPTION_CHARS, `At most ${MAX_DESCRIPTION_CHARS} characters.`);

/**
 * A step id. It is embedded in `{{<id>.output.<field>}}` references and in
 * block ids, so it may not contain whitespace or braces.
 */
export const stepIdSchema = z
  .string()
  .min(1)
  .max(
    MAX_STEP_ID_CHARS,
    `A step id is at most ${MAX_STEP_ID_CHARS} characters.`,
  )
  .regex(/^[^\s{}]+$/, 'A step id may not contain spaces or braces.');

/** A DID (`did:<method>:<id>`). */
export const didSchema = z
  .string()
  .max(MAX_DID_CHARS, `A DID is at most ${MAX_DID_CHARS} characters.`)
  .regex(/^did:[a-z0-9]+:\S+$/, 'Must be a DID, e.g. "did:ixo:ixo1…".');

/**
 * A step's inputs: at most {@link MAX_STEP_INPUTS} names and
 * {@link MAX_STEP_INPUTS_BYTES} UTF-8 bytes of JSON, and no secret (PIN,
 * mnemonic, password, token, API key) other than a step-output reference.
 * Whether that step exists is checked where the flow is known.
 */
export const stepInputsSchema = z
  .record(z.string().max(MAX_NAME_CHARS), z.unknown())
  .superRefine((inputs, issue) => {
    if (Object.keys(inputs).length > MAX_STEP_INPUTS)
      issue.addIssue({
        code: 'custom',
        message: `A step may have at most ${MAX_STEP_INPUTS} inputs.`,
      });
    if (jsonByteLength(inputs) > MAX_STEP_INPUTS_BYTES)
      issue.addIssue({
        code: 'custom',
        message: `A step's inputs may be at most ${MAX_STEP_INPUTS_BYTES} bytes of JSON.`,
      });
    const secrets = secretLiteralPaths(inputs);
    if (secrets.length > 0)
      issue.addIssue({
        code: 'custom',
        message: secretLiteralMessage(secrets),
      });
  });

export const conditionSchema = z.object({
  source: z
    .enum(['configured_input', 'runtime_output'])
    .describe(
      'Read authored inputs or successful runtime output. Required for newly authored conditions.',
    ),
  fromStep: stepIdSchema.describe(
    'Id of the upstream step whose value is checked.',
  ),
  field: nameSchema.describe('Field on the upstream step to inspect.'),
  is: z.enum(CONDITION_OPERATORS).describe('Comparison operator.'),
  value: z
    .unknown()
    .optional()
    .describe('Value to compare against (omit for isEmpty/isNotEmpty).'),
});

export const semanticGateSchema = z
  .object({
    version: z.literal(1),
    decision: z.literal('flow.gate.semantic'),
    criterion: z.string().min(1).max(4000),
    rubric: z.string().min(1).max(4000),
    inputFields: z.array(z.string().min(1).max(512)).min(1).max(50),
  })
  .strict();

export const hookSchema = z.object({
  type: z.enum(['sendEmail', 'addLinkedEntity', 'sendMatrixDM']),
  config: z.record(z.string().max(MAX_NAME_CHARS), z.unknown()),
});

export const dueSchema = z.object({
  at: nameSchema.optional().describe('Absolute due date (ISO 8601).'),
  within: nameSchema
    .optional()
    .describe(
      'Duration from when the step becomes active (ISO 8601 duration).',
    ),
  afterCommitment: nameSchema
    .optional()
    .describe('Duration from commitment (ISO 8601 duration).'),
});

export const onEventSchema = z.object({
  fromStep: stepIdSchema.describe('Upstream step that emits the event.'),
  event: nameSchema.describe('Event name the upstream step emits.'),
});

/**
 * A single step the agent authors. Mirrors FlowStep in the spec (§2.1). The
 * read-only `status` is intentionally absent here — agents never write it; it
 * is only attached on read (see FlowStepRead).
 */
export const flowStepSchema = z.object({
  id: stepIdSchema.describe(
    'Stable, human-readable step id, e.g. "load-batches".',
  ),
  action: nameSchema
    .min(1)
    .describe('Action name from list_actions (e.g. "qi/email.send").'),
  title: nameSchema.optional(),
  description: descriptionSchema.optional(),
  phase: nameSchema
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

  inputs: stepInputsSchema
    .optional()
    .describe(
      'Inputs for the action. A value may be a reference to an upstream output, written as "{{step-id.output.field}}". ' +
        'Never put a PIN, mnemonic, password, token or API key here: the portal collects those when the user runs the step.',
    ),
  form: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'For human form steps: pre-filled answers keyed by question name. Pre-fill only — the user submits in the portal.',
    ),

  after: z
    .array(stepIdSchema)
    .max(MAX_FLOW_STEPS)
    .optional()
    .describe(
      'Order this step after the named steps. Pair with an input reference for a real data dependency. This is ordering only, not an auto-trigger.',
    ),
  runWhen: conditionSchema
    .optional()
    .describe(
      'Gate this step on an upstream configured input or runtime output.',
    ),
  conditions: z
    .array(conditionSchema)
    .max(
      MAX_CONDITIONS_PER_STEP,
      `A step may have at most ${MAX_CONDITIONS_PER_STEP} conditions.`,
    )
    .optional()
    .describe('Multiple activation gates (all must pass).'),
  semanticGate: semanticGateSchema
    .optional()
    .describe(
      'Additional versioned semantic gate; cannot override deterministic conditions or authority.',
    ),
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

  assignTo: didSchema
    .optional()
    .describe(
      'The DID assigned to this step. Assigning AUTHORISES that DID to run the step (it is written to the ' +
        "step's authorised actors) — only assign a DID the user named and confirmed.",
    ),
  commitTo: nameSchema
    .optional()
    .describe('Commitment window (ISO 8601 duration).'),

  on: z
    .record(z.string(), z.array(hookSchema))
    .optional()
    .describe('Lifecycle hooks: event name -> hooks.'),
  skills: z
    .array(nameSchema)
    .max(
      MAX_SKILLS_PER_STEP,
      `A step may require at most ${MAX_SKILLS_PER_STEP} skills.`,
    )
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
 * {@link flowStepSchema} plus the whole-step size cap. A separate schema so
 * `flowStepSchema` stays a plain object that `.partial()` can derive from.
 */
export const sizedFlowStepSchema = flowStepSchema.refine(
  (step) => jsonByteLength(step) <= MAX_STEP_SPEC_BYTES,
  `A step may be at most ${MAX_STEP_SPEC_BYTES} bytes of JSON.`,
);

/**
 * A whole flow as the agent authors it. `ref` is the opaque flow handle; it is
 * omitted on create and assigned by the plugin.
 */
export const flowSpecSchema = z
  .object({
    ref: z
      .string()
      .optional()
      .describe(
        'Opaque flow handle. Omit when creating; the plugin assigns it.',
      ),
    title: nameSchema.min(1),
    goal: descriptionSchema.optional(),
    steps: z
      .array(sizedFlowStepSchema)
      .max(MAX_FLOW_STEPS, `A flow may have at most ${MAX_FLOW_STEPS} steps.`),
  })
  .refine(
    (flow) => jsonByteLength(flow) <= MAX_FLOW_SPEC_BYTES,
    `A flow may be at most ${MAX_FLOW_SPEC_BYTES} bytes of JSON; build a larger flow step by step with add_step.`,
  )
  .superRefine((flow, issue) => {
    // A secret reference must point at a step of this flow.
    const stepIds = new Set(flow.steps.map((step) => step.id));
    flow.steps.forEach((step, index) => {
      const secrets = secretLiteralPaths(step.inputs ?? {}, stepIds);
      if (secrets.length > 0)
        issue.addIssue({
          code: 'custom',
          path: ['steps', index, 'inputs'],
          message: secretLiteralMessage(secrets),
        });
    });
  });

export type Condition = z.infer<typeof conditionSchema>;
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

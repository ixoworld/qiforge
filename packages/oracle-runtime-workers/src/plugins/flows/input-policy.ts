/**
 * Limits and content rules for everything the agent writes into a flow
 * document. The schemas in `types.ts` apply them to tool input, and the edit
 * layer re-checks the ones that also guard direct writes.
 *
 * Sizes: matrix-crdt sends each batch of document changes as one Matrix
 * event, base64-encoded, and a homeserver refuses any event over 64 KiB of
 * UTF-8. A step's inputs are stored three times by an input edit (the block,
 * the compiled node's `props`, and the node itself), and a whole flow is
 * written in one batch by `create_template`. The JSON caps below are UTF-8
 * byte counts — a CJK character is three bytes, an emoji four — and keep
 * either kind of write well under the event limit; `limits.test.ts` measures
 * the worst case for ASCII, CJK and emoji.
 *
 * Secrets: a credential (PIN, mnemonic, password, access token, API key)
 * must never be stored in a flow document — every room member can read it —
 * and never pass through the chat. The portal collects them when the user
 * runs the step, so an input named like a secret port of any action may only
 * hold a `{{step.output.field}}` reference to a step of the same flow.
 *
 * No imports beyond the placeholder scanner and the action metadata (plain
 * data): `types.ts` is loaded at Worker boot and must not reach `@ixo/editor`.
 */
import { ACTION_METADATA } from './action-metadata';
import { wholeRef } from './ref-syntax';

/** Steps in one flow. */
export const MAX_FLOW_STEPS = 30;
/** UTF-8 bytes of a whole flow as JSON (one `create_template` write). */
export const MAX_FLOW_SPEC_BYTES = 16_000;
/** UTF-8 bytes of one step as JSON. */
export const MAX_STEP_SPEC_BYTES = 12_000;
/** Named inputs on one step. */
export const MAX_STEP_INPUTS = 40;
/** UTF-8 bytes of one step's inputs as JSON. */
export const MAX_STEP_INPUTS_BYTES = 8_000;
/** Characters of a step id. */
export const MAX_STEP_ID_CHARS = 64;
/** Characters of a flow or step title, a phase, a field or event name. */
export const MAX_NAME_CHARS = 200;
/** Characters of a description or goal. */
export const MAX_DESCRIPTION_CHARS = 2_000;
/** Conditions on one step. */
export const MAX_CONDITIONS_PER_STEP = 20;
/** Governed skill ids on one step. */
export const MAX_SKILLS_PER_STEP = 20;
/** Questions on one form. */
export const MAX_FORM_QUESTIONS = 50;
/** Choices on one form question. */
export const MAX_QUESTION_CHOICES = 50;
/** UTF-8 bytes of a form's pre-filled answers as JSON. */
export const MAX_FORM_ANSWERS_BYTES = 8_000;
/** Characters of a DID. */
export const MAX_DID_CHARS = 256;

/**
 * Input names (lower-cased) that carry a credential: every port any action
 * flags `secret`. Matched by name for every action, so a secret is refused
 * even on a step whose action does not declare that port.
 */
const SECRET_INPUT_NAMES: ReadonlySet<string> = new Set(
  Object.values(ACTION_METADATA).flatMap((entry) =>
    (entry.inputPorts ?? [])
      .filter((port) => port.secret)
      .map((port) => port.path.toLowerCase()),
  ),
);

const utf8 = new TextEncoder();

/** UTF-8 byte length of `value` serialised as JSON (0 when it cannot be serialised). */
export function jsonByteLength(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : utf8.encode(json).length;
  } catch {
    return 0;
  }
}

/** A step-output reference: `<step-id>.output.<field>`. */
const STEP_OUTPUT_REF = /^([^\s.{}]+)\.output\.[^\s{}]+$/;

/**
 * Whether a secret input's value may be stored: empty, or only references to
 * an output of a step of this flow (`stepIds`; any step id when omitted) —
 * as one string, or as every leaf of a map or list of them.
 */
function isAllowedSecretValue(
  value: unknown,
  stepIds: ReadonlySet<string> | undefined,
): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value === 'string') {
    const ref = wholeRef(value);
    const step = ref === undefined ? undefined : STEP_OUTPUT_REF.exec(ref)?.[1];
    return step !== undefined && (stepIds === undefined || stepIds.has(step));
  }
  if (Array.isArray(value))
    return value.every((item) => isAllowedSecretValue(item, stepIds));
  if (typeof value === 'object')
    return Object.values(value).every((item) =>
      isAllowedSecretValue(item, stepIds),
    );
  return false;
}

/**
 * Paths of every secret-named entry (at any depth) whose value is not an
 * allowed reference. `stepIds` are the steps a reference may point at; when
 * omitted (a step checked on its own) any step id is accepted.
 */
export function secretLiteralPaths(
  value: unknown,
  stepIds?: ReadonlySet<string>,
  path = '',
): string[] {
  if (Array.isArray(value))
    return value.flatMap((item, index) =>
      secretLiteralPaths(item, stepIds, `${path}[${index}]`),
    );
  if (!value || typeof value !== 'object') return [];
  const out: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    const at = path ? `${path}.${key}` : key;
    if (SECRET_INPUT_NAMES.has(key.toLowerCase())) {
      if (!isAllowedSecretValue(item, stepIds)) out.push(at);
    } else out.push(...secretLiteralPaths(item, stepIds, at));
  }
  return out;
}

/** The message every secret-literal refusal uses. */
export function secretLiteralMessage(paths: string[]): string {
  return (
    `Refusing to store a secret (PIN, mnemonic, password, token or API key) in the flow (${paths.join(', ')}). ` +
    'These are collected by the portal when the user runs the step; leave the input empty ' +
    'or reference an output of a step in this flow as "{{step-id.output.field}}". Never ask the user for one in chat.'
  );
}

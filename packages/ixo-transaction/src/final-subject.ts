/**
 * Final Decision Subject binding: authority is granted for a digest of the
 * exact action subject, and execution re-digests the subject immediately
 * before the side effect, so `approve(A) → mutate(A → B) → execute(B)` fails
 * closed.
 *
 * Hashing uses Web Crypto (`crypto.subtle`), available on Workers, Node 22+
 * and browsers, which makes the digest functions asynchronous. The subject is
 * canonicalised synchronously before the first await, so a value that changes
 * while the hash is computed cannot affect the digest.
 */

export type FinalDecisionSubjectValue =
  | null
  | boolean
  | number
  | string
  | readonly FinalDecisionSubjectValue[]
  | { readonly [key: string]: FinalDecisionSubjectValue };

export interface FinalDecisionSubject {
  kind: string;
  action: FinalDecisionSubjectValue;
  evidenceRefs?: readonly string[];
  policyRef?: string;
  context?: Readonly<Record<string, FinalDecisionSubjectValue>>;
}

export interface FinalDecisionSubjectBinding {
  algorithm: 'sha256';
  canonicalization: 'ixo-json-v1';
  /** Lowercase hex SHA-256 of the canonical UTF-8 bytes. */
  subjectDigest: string;
}

export interface DecisionAuthorityReceipt {
  subject: FinalDecisionSubjectBinding;
  /** How authority was established, e.g. `ucan`, `contract-gate`, `human-approval`. */
  mechanism: string;
  authorizedAt: string;
  reference?: string;
}

export interface DecisionExecutionReceipt {
  subject: FinalDecisionSubjectBinding;
  /**
   * Digest of the complete executed subject. Equal to
   * `subject.subjectDigest`, and to the authority receipt's digest.
   */
  actionDigest: string;
  executedAt: string;
  reference?: string;
}

export class StaleDecisionSubjectError extends Error {
  constructor(
    readonly expectedDigest: string,
    readonly actualDigest: string,
  ) {
    super(
      `Final Decision Subject changed after authorization: expected ${expectedDigest}, got ${actualDigest}.`,
    );
    this.name = 'StaleDecisionSubjectError';
  }
}

const ALGORITHM = 'sha256';
const CANONICALIZATION = 'ixo-json-v1';

/**
 * What `createDecisionExecutionReceipt` hands back: the receipt, and the
 * subject exactly as it was hashed (parsed from the canonical form and deeply
 * frozen). The side effect must be performed from `subject`, never from the
 * caller's original object, which can still change after the check.
 */
export interface DecisionExecution {
  receipt: DecisionExecutionReceipt;
  subject: Readonly<FinalDecisionSubject>;
}

/**
 * Canonical JSON (`ixo-json-v1`) for any value: object keys sorted by UTF-16
 * code unit, array order preserved, no whitespace, `-0` written as `0`,
 * numbers and strings as `JSON.stringify` writes them (so `1e21` is `1e+21`
 * and a lone surrogate is a `\uXXXX` escape). Only plain JSON is accepted;
 * anything whose JSON serialisation could silently change meaning (undefined,
 * functions, symbols, bigint, non-finite numbers, sparse arrays, cycles,
 * Dates, Maps, typed arrays and other class instances) is rejected.
 *
 * The input is traversed once: every own enumerable property, array length
 * and array element is read exactly once, so an accessor cannot show the
 * validation one value and the serialisation another.
 */
export function canonicalizeIxoJson(value: unknown): string {
  return canonicalizeJson(value, '$', []);
}

/**
 * `ixo-json-v1` of a Final Decision Subject. Beyond the canonical form it
 * requires a non-empty string `kind`, an `action`, string `evidenceRefs`, a
 * string `policyRef` and an object `context`; those checks run on the
 * canonical output, so they see exactly the values that were serialised.
 */
export function canonicalizeFinalDecisionSubject(
  subject: FinalDecisionSubject,
): string {
  return canonicalizeSubject(subject).canonical;
}

export async function digestFinalDecisionSubject(
  subject: FinalDecisionSubject,
): Promise<FinalDecisionSubjectBinding> {
  return bindCanonical(canonicalizeSubject(subject).canonical);
}

export async function createDecisionAuthorityReceipt(input: {
  subject: FinalDecisionSubject;
  mechanism: string;
  reference?: string;
  authorizedAt?: Date | string;
}): Promise<DecisionAuthorityReceipt> {
  if (!input.mechanism.trim()) {
    throw new TypeError('Authority mechanism must be non-empty.');
  }
  const authorizedAt = toIsoTimestamp(input.authorizedAt);

  return {
    subject: await digestFinalDecisionSubject(input.subject),
    mechanism: input.mechanism,
    authorizedAt,
    ...(input.reference ? { reference: input.reference } : {}),
  };
}

/**
 * Re-digests the current subject and throws `StaleDecisionSubjectError` when
 * any material field changed since `binding` was made.
 */
export async function assertFinalDecisionSubjectUnchanged(
  binding: FinalDecisionSubjectBinding,
  currentSubject: FinalDecisionSubject,
): Promise<void> {
  assertBindingMatches(
    binding,
    await digestFinalDecisionSubject(currentSubject),
  );
}

/**
 * Checks that the subject about to be executed still matches the one
 * authority was granted for and, only then, returns the execution receipt
 * together with the subject exactly as hashed. Call it immediately before the
 * side effect and perform the effect from the returned `subject`: it is a
 * deeply frozen copy parsed from the canonical bytes the digest covers, while
 * `currentSubject` is read once and may change afterwards.
 */
export async function createDecisionExecutionReceipt(input: {
  authority: DecisionAuthorityReceipt;
  currentSubject: FinalDecisionSubject;
  reference?: string;
  executedAt?: Date | string;
}): Promise<DecisionExecution> {
  const executedAt = toIsoTimestamp(input.executedAt);
  const { canonical, parsed } = canonicalizeSubject(input.currentSubject);
  const binding = await bindCanonical(canonical);
  assertBindingMatches(input.authority.subject, binding);

  return {
    receipt: {
      subject: binding,
      actionDigest: binding.subjectDigest,
      executedAt,
      ...(input.reference ? { reference: input.reference } : {}),
    },
    subject: deepFreeze(parsed),
  };
}

function canonicalizeSubject(subject: unknown): {
  canonical: string;
  parsed: FinalDecisionSubject;
} {
  const canonical = canonicalizeJson(subject, 'subject', []);
  // Parsing the canonical output (never re-reading `subject`) gives a value
  // that is exactly what was serialised.
  const parsed: unknown = JSON.parse(canonical);
  assertFinalDecisionSubjectShape(parsed);
  return { canonical, parsed };
}

function assertFinalDecisionSubjectShape(
  value: unknown,
): asserts value is FinalDecisionSubject {
  if (!isJsonObject(value)) {
    throw new TypeError('Final Decision Subject must be a plain object.');
  }
  if (typeof value.kind !== 'string' || !value.kind.trim()) {
    throw new TypeError('Final Decision Subject kind must be non-empty.');
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'action')) {
    throw new TypeError('Final Decision Subject action is required.');
  }
  const { evidenceRefs, policyRef, context } = value;
  if (
    evidenceRefs !== undefined &&
    !(
      Array.isArray(evidenceRefs) &&
      evidenceRefs.every((ref) => typeof ref === 'string')
    )
  ) {
    throw new TypeError(
      'Final Decision Subject evidenceRefs must be an array of strings.',
    );
  }
  if (policyRef !== undefined && typeof policyRef !== 'string') {
    throw new TypeError('Final Decision Subject policyRef must be a string.');
  }
  if (context !== undefined && !isJsonObject(context)) {
    throw new TypeError('Final Decision Subject context must be an object.');
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

async function bindCanonical(
  canonical: string,
): Promise<FinalDecisionSubjectBinding> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical),
  );
  return {
    algorithm: ALGORITHM,
    canonicalization: CANONICALIZATION,
    subjectDigest: toHex(new Uint8Array(digest)),
  };
}

/**
 * Digests are public values (anyone holding the subject can compute one), so
 * plain equality leaks nothing an attacker could not already derive.
 */
function assertBindingMatches(
  expected: FinalDecisionSubjectBinding,
  actual: FinalDecisionSubjectBinding,
): void {
  if (
    expected.algorithm !== actual.algorithm ||
    expected.canonicalization !== actual.canonicalization ||
    expected.subjectDigest !== actual.subjectDigest
  ) {
    throw new StaleDecisionSubjectError(
      expected.subjectDigest,
      actual.subjectDigest,
    );
  }
}

/**
 * `ancestors` holds the objects and arrays on the current path, so a cycle is
 * rejected while a value shared by two branches (no cycle) is allowed.
 */
function canonicalizeJson(
  value: unknown,
  path: string,
  ancestors: object[],
): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(
          `Final Decision Subject numbers must be finite JSON numbers (at ${path}).`,
        );
      }
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'object': {
      if (ancestors.includes(value)) {
        throw new TypeError(
          `Final Decision Subject must not contain cycles (at ${path}).`,
        );
      }
      const inner = [...ancestors, value];
      if (Array.isArray(value)) {
        const length = value.length;
        const items: string[] = [];
        for (let index = 0; index < length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(value, index)) {
            throw new TypeError(
              `Final Decision Subject arrays must not contain sparse holes (at ${path}).`,
            );
          }
          const item: unknown = value[index];
          items.push(canonicalizeJson(item, `${path}[${index}]`, inner));
        }
        return `[${items.join(',')}]`;
      }
      if (!isPlainObject(value)) {
        throw new TypeError(
          `Final Decision Subject objects must be plain JSON objects (at ${path}).`,
        );
      }
      // One `Object.entries` call reads every own enumerable property once.
      const entries = Object.entries(value).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      return `{${entries
        .map(([key, item]) => {
          if (item === undefined) {
            throw new TypeError(
              `Final Decision Subject field "${key}" is not JSON-safe (at ${path}).`,
            );
          }
          return `${JSON.stringify(key)}:${canonicalizeJson(item, `${path}.${key}`, inner)}`;
        })
        .join(',')}}`;
    }
    default:
      throw new TypeError(
        `Final Decision Subject contains a non-JSON ${typeof value} (at ${path}).`,
      );
  }
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function toIsoTimestamp(value?: Date | string): string {
  if (value === undefined) return new Date().toISOString();

  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('Receipt timestamp must be a valid date.');
  }
  return date.toISOString();
}

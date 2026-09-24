import { createHash, timingSafeEqual } from 'node:crypto';

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
  subjectDigest: string;
}

export interface DecisionAuthorityReceipt {
  subject: FinalDecisionSubjectBinding;
  mechanism: string;
  authorizedAt: string;
  reference?: string;
}

export interface DecisionExecutionReceipt {
  subject: FinalDecisionSubjectBinding;
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

/**
 * Canonical JSON used for Final Decision Subject binding.
 *
 * ixo-json-v1 deliberately supports only JSON-safe values, sorts object keys,
 * preserves array order, and rejects values whose normal JSON serialization can
 * silently change meaning (undefined, functions, symbols, bigint, NaN, Infinity,
 * and sparse arrays).
 */
export function canonicalizeFinalDecisionSubject(
  subject: FinalDecisionSubject,
): string {
  if (!subject.kind.trim()) {
    throw new TypeError('Final Decision Subject kind must be non-empty.');
  }
  return canonicalizeJson(subject as unknown as FinalDecisionSubjectValue);
}

export function digestFinalDecisionSubject(
  subject: FinalDecisionSubject,
): FinalDecisionSubjectBinding {
  const canonical = canonicalizeFinalDecisionSubject(subject);
  const subjectDigest = createHash('sha256')
    .update(canonical, 'utf8')
    .digest('hex');

  return {
    algorithm: 'sha256',
    canonicalization: 'ixo-json-v1',
    subjectDigest,
  };
}

export function createDecisionAuthorityReceipt(input: {
  subject: FinalDecisionSubject;
  mechanism: string;
  reference?: string;
  authorizedAt?: Date | string;
}): DecisionAuthorityReceipt {
  if (!input.mechanism.trim()) {
    throw new TypeError('Authority mechanism must be non-empty.');
  }

  return {
    subject: digestFinalDecisionSubject(input.subject),
    mechanism: input.mechanism,
    authorizedAt: toIsoTimestamp(input.authorizedAt),
    ...(input.reference ? { reference: input.reference } : {}),
  };
}

/**
 * Recomputes the current subject digest immediately before consequence.
 * Throws if any material field changed since authorization.
 */
export function assertFinalDecisionSubjectUnchanged(
  binding: FinalDecisionSubjectBinding,
  currentSubject: FinalDecisionSubject,
): void {
  assertBindingMatches(binding, digestFinalDecisionSubject(currentSubject));
}

/**
 * Creates an execution receipt only after checking the action still matches the
 * subject that authority was granted for. The subject is digested exactly once
 * so accessor-backed or proxied values cannot change between validation and
 * receipt creation.
 */
export function createDecisionExecutionReceipt(input: {
  authority: DecisionAuthorityReceipt;
  currentSubject: FinalDecisionSubject;
  reference?: string;
  executedAt?: Date | string;
}): DecisionExecutionReceipt {
  const binding = digestFinalDecisionSubject(input.currentSubject);
  assertBindingMatches(input.authority.subject, binding);

  return {
    subject: binding,
    actionDigest: binding.subjectDigest,
    executedAt: toIsoTimestamp(input.executedAt),
    ...(input.reference ? { reference: input.reference } : {}),
  };
}

function assertBindingMatches(
  expected: FinalDecisionSubjectBinding,
  actual: FinalDecisionSubjectBinding,
): void {
  if (
    expected.algorithm !== actual.algorithm ||
    expected.canonicalization !== actual.canonicalization ||
    !safeHexEqual(expected.subjectDigest, actual.subjectDigest)
  ) {
    throw new StaleDecisionSubjectError(
      expected.subjectDigest,
      actual.subjectDigest,
    );
  }
}

function canonicalizeJson(value: FinalDecisionSubjectValue): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(
          'Final Decision Subject numbers must be finite JSON numbers.',
        );
      }
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'object':
      if (Array.isArray(value)) {
        if (Object.keys(value).length !== value.length) {
          throw new TypeError(
            'Final Decision Subject arrays must not contain sparse holes.',
          );
        }
        return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`;
      }

      if (!isPlainObject(value)) {
        throw new TypeError(
          'Final Decision Subject objects must be plain JSON objects.',
        );
      }

      return `{${Object.keys(value)
        .sort()
        .map((key) => {
          const item = value[key];
          if (!isSupportedJsonValue(item)) {
            throw new TypeError(
              `Final Decision Subject field "${key}" is not JSON-safe.`,
            );
          }
          return `${JSON.stringify(key)}:${canonicalizeJson(item)}`;
        })
        .join(',')}}`;
    default:
      throw new TypeError('Final Decision Subject contains a non-JSON value.');
  }
}

function isSupportedJsonValue(
  value: unknown,
): value is FinalDecisionSubjectValue {
  if (value === null) return true;
  if (
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    typeof value === 'number'
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) return false;
    return value.every(isSupportedJsonValue);
  }
  if (isPlainObject(value)) {
    return Object.values(value).every(isSupportedJsonValue);
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeHexEqual(a: string, b: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(a) || !/^[0-9a-f]{64}$/i.test(b)) return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function toIsoTimestamp(value?: Date | string): string {
  if (value === undefined) return new Date().toISOString();

  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('Receipt timestamp must be a valid date.');
  }
  return date.toISOString();
}

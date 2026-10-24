import { z } from 'zod';

export const CATALOG_VERSION = '2.0.0';
export const SOURCE_ENVELOPE_VERSION = 1;
export const text = z.string().min(1).max(4000);
export const decimal = z
  .string()
  .max(100)
  .regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);
export const positiveDecimal = z
  .string()
  .max(100)
  .regex(/^(?!0(?:\.0+)?$)(0|[1-9][0-9]*)(\.[0-9]+)?$/);
export const list = <S extends z.ZodType>(schema: S) =>
  z.array(schema).max(100);
export const hostFactsSchema = z.strictObject({
  userDid: text,
  oracleDid: text,
  network: text,
  sessionId: text,
  roomId: text,
  visibility: z.enum(['private', 'shared']),
  timezone: text,
});
export type HostFacts = Readonly<z.output<typeof hostFactsSchema>>;
export const evidenceSourceSchema = z.enum([
  'account_binding',
  'subscriptions',
  'canonical_document',
  'error_catalog',
  'operation_error',
  'vfs',
  'attachment',
  'offramp',
  'operation',
  'personal_memory',
  'oracle_knowledge',
]);
export type EvidenceSource = z.output<typeof evidenceSourceSchema>;
export const evidenceSchema = z.strictObject({
  source: evidenceSourceSchema,
  reference: text,
  revision: text,
  observedAt: text,
  freshness: z.enum(['current', 'historical', 'unknown']),
});
export const timestampSchema = z.iso.datetime({ offset: true });
export const validTimestamp = (value: string) =>
  timestampSchema.safeParse(value).success;
export type Evidence = Readonly<z.output<typeof evidenceSchema>>;
export type DisclosedEvidence = Evidence & Readonly<{ network: string }>;
export const envelopeSchema = z.discriminatedUnion('status', [
  z.strictObject({
    version: z.literal(1),
    status: z.literal('available'),
    scope: hostFactsSchema,
    value: z.unknown(),
    evidence: z.unknown(),
  }),
  z.strictObject({ version: z.literal(1), status: z.literal('unauthorized') }),
  z.strictObject({ version: z.literal(1), status: z.literal('unavailable') }),
]);
export type DeepReadonly<T> = T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;
export function freeze<const T>(value: T): DeepReadonly<T>;
export function freeze(value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

type PlainData =
  | null
  | boolean
  | number
  | string
  | PlainData[]
  | { [key: string]: PlainData };

export function copyBoundedPlainData(value: unknown): PlainData {
  const seen = new Set<object>();
  let nodes = 0;
  function copy(input: unknown, depth: number): PlainData {
    if (++nodes > 100000 || depth > 32)
      throw new TypeError('Invalid plain data');
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'string' && input.length <= 1000000) return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (typeof input !== 'object' || seen.has(input))
      throw new TypeError('Invalid plain data');
    seen.add(input);
    try {
      const array = Array.isArray(input);
      if (
        Object.getPrototypeOf(input) !==
        (array ? Array.prototype : Object.prototype)
      )
        throw new TypeError('Invalid plain data');
      const keys = Reflect.ownKeys(input);
      if (keys.length > 10000) throw new TypeError('Invalid plain data');
      const result: { [key: string]: PlainData } = {};
      const items: PlainData[] = [];
      for (const key of keys) {
        if (array && key === 'length') continue;
        if (typeof key !== 'string') throw new TypeError('Invalid plain data');
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
          throw new TypeError('Invalid plain data');
        const child = copy(descriptor.value, depth + 1);
        if (array) {
          if (key !== String(items.length))
            throw new TypeError('Invalid plain data');
          items.push(child);
        } else
          Object.defineProperty(result, key, {
            value: child,
            enumerable: true,
            configurable: true,
            writable: true,
          });
      }
      if (array && items.length !== input.length)
        throw new TypeError('Invalid plain data');
      return array ? items : result;
    } finally {
      seen.delete(input);
    }
  }
  return copy(value, 0);
}

export type InvalidRequestReason = 'unknown_tool' | 'invalid_arguments';
export type UnauthorizedReason =
  | 'invalid_context'
  | 'disclosure_denied'
  | 'grant_missing'
  | 'grant_expired'
  | 'source_denied'
  | 'scope_denied'
  | 'resource_denied';
export type UnavailableReason =
  | 'authorization_unavailable'
  | 'restricted_adapter_required'
  | 'not_integrated'
  | 'resource_check_not_integrated'
  | 'upstream_failed'
  | 'source_unavailable'
  | 'invalid_source_response'
  | 'ambiguous_balance'
  | 'quote_expired'
  | 'quote_mismatch'
  | 'error_mismatch'
  | 'evidence_missing'
  | 'invalid_evidence'
  | 'evidence_stale'
  | 'resource_check_failed';
export type Refusal =
  | Readonly<{ status: 'invalid_request'; reason: InvalidRequestReason }>
  | Readonly<{ status: 'unauthorized'; reason: UnauthorizedReason }>
  | Readonly<{
      status: 'unavailable';
      reason: UnavailableReason;
      retryable: boolean;
    }>;
export function unavailable(reason: UnavailableReason): Refusal {
  return Object.freeze({
    status: 'unavailable',
    reason,
    retryable: [
      'upstream_failed',
      'source_unavailable',
      'authorization_unavailable',
      'resource_check_failed',
      'evidence_stale',
      'quote_expired',
    ].includes(reason),
  });
}
export function unauthorized(reason: UnauthorizedReason): Refusal {
  return Object.freeze({ status: 'unauthorized', reason });
}
export function invalid(reason: InvalidRequestReason): Refusal {
  return Object.freeze({ status: 'invalid_request', reason });
}
export function sameScope(a: HostFacts, b: HostFacts): boolean {
  return (
    a.userDid === b.userDid &&
    a.oracleDid === b.oracleDid &&
    a.network === b.network &&
    a.sessionId === b.sessionId &&
    a.roomId === b.roomId &&
    a.visibility === b.visibility &&
    a.timezone === b.timezone
  );
}

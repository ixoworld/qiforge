/**
 * @fileoverview The record of a decision, and the chain that makes it evidence.
 *
 * A gate that refuses well and remembers nothing is an assertion, not an
 * account. This module is the account: every verdict the gate reaches —
 * permits included, because a log of only refusals cannot show that anything
 * was checked — becomes a record, and every record is bound to the one before
 * it by a hash. Rewriting history means rewriting every record after the one
 * you touched, and the head pointer says how many there should be.
 *
 * Pure, like the evaluator: no I/O, no clock of its own, no Matrix. Where the
 * records are *published* is a transport concern that lives in the service.
 *
 * ## Shape
 *
 * The field names are UDID's (`iss`, `aud`, `iat`, `jti`, `rub`, `cap`) even
 * though a gate decision is not a UDID and must not be mistaken for one. A
 * UDID is a determination made by an independent evaluator over a claim that
 * has already happened; this is an authorization made by the harness over an
 * action that has not happened yet. Keeping generation and determination
 * distinct is the invariant the whole design rests on.
 *
 * What the shared naming buys is that the two line up when a human review
 * resolution later *is* issued as a UDID: the reviewer is the evaluator, the
 * gated action is the claim, and `rub.id` already identifies the exact rules
 * that applied. Phase 5 becomes a schema extension rather than a migration.
 *
 * ## What is deliberately not recorded
 *
 * The raw capability token — only its digest. A decisions room readable by
 * anyone who can audit the entity must not double as a place to harvest
 * bearer credentials.
 *
 * The tool's arguments. They are model-supplied and can carry anything a user
 * typed. The decision-relevant facts are the action class, the operation, the
 * object and the value, and those are recorded in full. An audit trail holds
 * reproducible rationale, not a transcript.
 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  AuthorizationDecision,
  AuthorizationRequest,
  Obligation,
} from './authorize.js';

// ---------------------------------------------------------------------------
// JSON canonicalization (RFC 8785)
// ---------------------------------------------------------------------------

/**
 * Serializes a value to its RFC 8785 canonical form.
 *
 * A hash chain is only tamper-evident if everyone hashing the same record
 * produces the same bytes, and `JSON.stringify` does not promise that: key
 * order follows insertion order, so two runtimes building the same record
 * from differently-ordered literals would disagree about its hash and each
 * would read the other's chain as broken.
 *
 * Three rules do the work. Object keys sort by UTF-16 code unit — which is
 * what JavaScript's default string comparison already is, so a plain `sort()`
 * is correct rather than merely convenient. Numbers use ECMAScript's
 * number-to-string, with `-0` normalised to `0`. Strings use
 * `JSON.stringify`, which since well-formed stringify has been exactly the
 * escaping RFC 8785 requires, lone surrogates included.
 *
 * Takes `unknown` and rejects what it cannot represent. A canonicalizer that
 * quietly dropped a `Date`, a `Map` or a `bigint` would produce a hash over
 * less than it was given — and a chain that verifies over less than it covers
 * is worse than no chain, because it reads as evidence.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `Cannot canonicalize the non-finite number ${String(value)}.`,
      );
    }
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Cannot canonicalize a value of type ${typeof value}.`);
  }

  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(
      `Cannot canonicalize a ${value.constructor?.name ?? 'non-plain'} instance; JSON has no representation for it.`,
    );
  }

  const record: Record<string, unknown> = { ...value };
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
  return `{${entries.join(',')}}`;
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/** How the gate reached the class it evaluated — declared, or assumed. */
export type EffectProvenance = 'declared' | 'assumed';

export interface DecisionRecord {
  /** Position in the chain. Starts at 0 and never skips. */
  readonly seq: number;
  /** Hash of the preceding record; null only for the first. */
  readonly prev_hash: string | null;
  /** sha256 of this record's canonical form with `hash` itself omitted. */
  readonly hash: string;

  /** The entity whose constitution decided this — its own identifier. */
  readonly iss: string;
  /** The context the decision was made in. Phase 1 records the session. */
  readonly aud: string | null;
  /** When the decision was reached, per the declared clock. */
  readonly iat: string;
  /** Unique id for this record, so a replay can be recognised as one. */
  readonly jti: string;

  /**
   * The rules that applied, identified exactly. `id` is
   * `<domain_md_cid>@<document_revision>`: change the document and the id
   * changes with it, so a record can never be read against rules it was not
   * decided under.
   */
  readonly rub: { readonly authority: string; readonly id: string };
  /** Digest of the capability proof presented, never the proof itself. */
  readonly cap: { readonly cid: string } | null;

  readonly request: {
    readonly principal: {
      readonly did: string;
      readonly session_id: string;
      /** Which model proposed this. Transient by design — the record is not. */
      readonly model: string | null;
    };
    readonly tool: string;
    readonly action: string;
    readonly operation: string;
    readonly object: string;
    readonly value: { readonly amount: string; readonly denom: string } | null;
    /** Which declared account the value moved from, for value-bearing calls. */
    readonly account: string | null;
    /**
     * Whether the action class came from the tool or was assumed for it.
     * A permit granted on an assumed class is a weaker statement than one
     * granted on a declared class, and the record has to say which it was.
     */
    readonly effect: EffectProvenance;
  };

  readonly verdict: {
    readonly outcome: string;
    readonly reason_codes: readonly string[];
    readonly rule_refs: readonly string[];
    readonly obligations: readonly Obligation[];
    readonly matched_grant_id: string | null;
    readonly capability_revoked: boolean | null;
  };

  readonly time: {
    readonly source: string;
    readonly instant: string;
    /** False means expiry and revocation were checked against nothing. */
    readonly trusted: boolean;
  };
}

/** What the caller supplies; the chain derives everything else. */
export interface DecisionRecordInput {
  toolName: string;
  request: AuthorizationRequest;
  decision: AuthorizationDecision;
  effectAssumed: boolean;
  /** Constitution identity — `authority` is the subject, `id` is cid@revision. */
  rub: { authority: string; id: string };
  /** Context the decision was made in. */
  aud: string | null;
}

/** sha256 over the canonical form of everything but the hash field itself. */
function hashRecord(record: Omit<DecisionRecord, 'hash'>): string {
  return createHash('sha256')
    .update(canonicalize(record), 'utf8')
    .digest('hex');
}

/**
 * Digest of the request a decision was about.
 *
 * A human approval has to name something. If it named the tool it would
 * approve every later call to that tool; if it named the decision it would be
 * unusable, since the retry produces a different decision. It names the
 * request — the same action on the same object for the same value — so an
 * approval covers the thing a person actually looked at and nothing else.
 *
 * The session is deliberately excluded. An approval is about what may be
 * done, and requiring the operator to approve it again in each new session
 * would train them to approve without reading.
 */
export function digestRequest(request: AuthorizationRequest): string {
  const bound = {
    principal: request.principal.did,
    action: request.action,
    operation: request.operation,
    object: request.object,
    value: request.value
      ? { amount: request.value.amount, denom: request.value.denom }
      : null,
  };
  return createHash('sha256').update(canonicalize(bound), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

export interface DecisionChainOptions {
  /** Mints `jti`. Injected so a test can produce a chain it can predict. */
  newId?: () => string;
}

/**
 * An append-only sequence of decisions, each bound to its predecessor.
 *
 * Appending is synchronous and cannot fail, which is the point: the record is
 * made *before* the tool runs, so there is no window in which an action has
 * happened and nothing says why it was allowed to. Publishing the record is a
 * separate, slower problem, and it belongs to whoever owns the transport.
 *
 * One chain per process. Two writers would fork it — both would read the same
 * head, both would claim the same `seq`, and the fork would only be visible
 * to whoever later tried to verify it.
 */
export class DecisionChain {
  /**
   * Every record, in order.
   *
   * Retained rather than only the head because the chain is the entity's own
   * account of what it did, and questions like "how much has this account
   * moved today" have no other honest source. Bounded by process lifetime; the
   * published room is the durable copy.
   */
  private readonly entries: DecisionRecord[] = [];

  private head: DecisionRecord | null = null;

  private count = 0;

  private readonly newId: () => string;

  constructor(options: DecisionChainOptions = {}) {
    this.newId = options.newId ?? randomUUID;
  }

  /** The most recent record, or null before anything has been decided. */
  get tip(): DecisionRecord | null {
    return this.head;
  }

  /** How many decisions this chain has recorded. */
  get length(): number {
    return this.count;
  }

  /** The record at a position, or undefined past the end. */
  at(index: number): DecisionRecord | undefined {
    return this.entries[index];
  }

  /** Every record, oldest first. Frozen, like the records themselves. */
  records(): readonly DecisionRecord[] {
    return this.entries;
  }

  append(input: DecisionRecordInput): DecisionRecord {
    const { request, decision } = input;
    const unhashed: Omit<DecisionRecord, 'hash'> = {
      seq: this.count,
      prev_hash: this.head?.hash ?? null,
      iss: request.principal.did,
      aud: input.aud,
      iat: decision.time.instant,
      jti: this.newId(),
      rub: { authority: input.rub.authority, id: input.rub.id },
      cap: decision.capability
        ? { cid: decision.capability.proofDigest }
        : null,
      request: {
        principal: {
          did: request.principal.did,
          session_id: request.principal.sessionId,
          model: request.principal.model ?? null,
        },
        tool: input.toolName,
        action: request.action,
        operation: request.operation,
        object: request.object,
        value: request.value
          ? { amount: request.value.amount, denom: request.value.denom }
          : null,
        account: request.account ?? null,
        effect: input.effectAssumed ? 'assumed' : 'declared',
      },
      verdict: {
        outcome: decision.outcome,
        reason_codes: [...decision.reasonCodes],
        rule_refs: [...decision.ruleRefs],
        obligations: decision.obligations.map((obligation) => ({
          ...obligation,
        })),
        matched_grant_id: decision.matchedGrantId ?? null,
        capability_revoked: decision.capability?.revoked ?? null,
      },
      time: {
        source: decision.time.source,
        instant: decision.time.instant,
        trusted: decision.time.trusted,
      },
    };

    const record: DecisionRecord = Object.freeze({
      ...unhashed,
      hash: hashRecord(unhashed),
    });
    this.entries.push(record);
    this.head = record;
    this.count += 1;
    return record;
  }
}

/** Why a chain failed verification, in the terms an auditor needs. */
export interface ChainBreak {
  seq: number;
  reason: 'sequence-gap' | 'broken-link' | 'hash-mismatch';
  detail: string;
}

/**
 * Recomputes a chain and reports where it stops holding together.
 *
 * Verification is the reason the records exist, so it is exported rather than
 * kept as a test helper: an auditor reading a decisions room should be able to
 * run the same check the runtime would.
 */
export function verifyChain(
  records: readonly DecisionRecord[],
): ChainBreak | null {
  const first = records[0];
  if (!first) return null;

  let previous: DecisionRecord | null = null;
  for (const record of records) {
    // The first record is taken at its word: a chain read back from a room
    // may legitimately start partway through, and demanding it start at zero
    // would report every paginated read as tampered.
    const expectedSeq = previous ? previous.seq + 1 : first.seq;
    if (record.seq !== expectedSeq) {
      return {
        seq: record.seq,
        reason: 'sequence-gap',
        detail: `Expected seq ${expectedSeq}, found ${record.seq}.`,
      };
    }
    const expectedPrev = previous ? previous.hash : record.prev_hash;
    if (record.prev_hash !== expectedPrev) {
      return {
        seq: record.seq,
        reason: 'broken-link',
        detail: `prev_hash does not name the preceding record.`,
      };
    }
    const { hash, ...rest } = record;
    if (hashRecord(rest) !== hash) {
      return {
        seq: record.seq,
        reason: 'hash-mismatch',
        detail: 'Record content does not hash to its stated hash.',
      };
    }
    previous = record;
  }
  return null;
}

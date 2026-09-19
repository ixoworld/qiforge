/**
 * Memory Engine Contract v1 — conformance types.
 *
 * The checks in `checks.ts` are written against {@link MemoryEngineProbe},
 * not against HTTP. That keeps them runnable in three situations:
 *
 *   1. Against a live engine, via `HttpMemoryEngineProbe` (real MCP + REST).
 *   2. Against an in-process reference implementation, to prove the checks
 *      themselves discriminate (see `checks.test.ts`).
 *   3. Against a fork's own engine, without that fork adopting our transport
 *      assumptions.
 *
 * Spec: `specs/memory-engine-contract-v1.md`.
 */

/** The six wire tool names an engine must expose. Order is the spec's order. */
export const REQUIRED_TOOLS = [
  'search_memory_engine',
  'add_memory',
  'add_oracle_knowledge',
  'delete_episode',
  'delete_edge',
  'clear',
] as const;

export type RequiredTool = (typeof REQUIRED_TOOLS)[number];

/** The eight retrieval strategies of contract §7.3. */
export const SEARCH_STRATEGIES = [
  'balanced',
  'diverse',
  'precise',
  'contextual',
  'recent_memory',
  'facts_only',
  'entities_only',
  'topics_only',
] as const;

/**
 * A representative slice of the ontology (§7.1–7.2) used by MEC-14. Deliberately
 * not the full list — the check exists to prove documented values are accepted,
 * including the IXO/Qi additions that `@ixo/common` currently omits (drift #1).
 */
export const ONTOLOGY_SAMPLE = {
  nodeLabels: ['Person', 'Project', 'Claim', 'VerifiableCredential'],
  edgeTypes: ['Knows', 'WorksOn', 'SUBMITS_CLAIM', 'TRIGGERS_PAYMENT'],
} as const;

/** Auth material for one probe call. `invocation: null` exercises MEC-04. */
export interface ProbeAuth {
  /** Serialized UCAN invocation, or null to send none. */
  invocation: string | null;
  /** Matrix room id for `x-room-id`, or null to omit the header (MEC-07). */
  roomId: string | null;
}

/** Minimal tool descriptor — the slice conformance actually inspects. */
export interface ProbeToolDescriptor {
  name: string;
  description: string;
}

/**
 * Outcome of a call. Modelled as a discriminated union rather than
 * throw-on-error because *rejection is the expected result* for half these
 * checks — MEC-04/05/07/11 all assert a failure, and an exception-based API
 * would force every check to wrap calls in try/catch just to read the status.
 */
export type ProbeOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; status: number | null; error: string };

/** Body of `POST /search-enhanced-batch`. Shapes per contract §6.1. */
export interface BatchQuery {
  oracle_dids: string[];
  query: string;
  strategy?: string;
  knowledge_level?: 'user' | 'oracle' | 'both';
  center_node_uuid?: string | null;
  search_filters?: Record<string, unknown> | null;
}

/** One slot of a batch response — either a result or a per-slot error. */
export type BatchSlot = Record<string, unknown>;

/** One message in `POST /messages`. */
export interface IngestMessage {
  content: string;
  role_type: 'user' | 'assistant' | 'system';
  role?: string;
  name?: string;
  source_description?: string;
}

/**
 * The surface a conformance target must expose. An implementer wiring their own
 * engine into the suite implements this and nothing else.
 */
export interface MemoryEngineProbe {
  /** MCP `tools/list`. */
  listTools(auth: ProbeAuth): Promise<ProbeOutcome<ProbeToolDescriptor[]>>;

  /** MCP `tools/call`. */
  callTool(
    name: string,
    args: Record<string, unknown>,
    auth: ProbeAuth,
  ): Promise<ProbeOutcome<unknown>>;

  /** `POST /search-enhanced-batch`. Absent ⇒ Full-level checks are skipped. */
  searchBatch?(
    queries: BatchQuery[],
    auth: ProbeAuth,
  ): Promise<ProbeOutcome<{ results: BatchSlot[] }>>;

  /** `POST /messages`. Absent ⇒ Full-level checks are skipped. */
  postMessages?(
    messages: IngestMessage[],
    auth: ProbeAuth,
  ): Promise<ProbeOutcome<unknown>>;
}

export type CheckStatus = 'pass' | 'fail' | 'skip';

export type ConformanceLevel = 'core' | 'full';

/** One check's verdict. */
export interface CheckResult {
  /** Stable identifier, e.g. `MEC-13`. */
  id: string;
  title: string;
  /** Spec section this check enforces, e.g. `§4`. */
  section: string;
  level: ConformanceLevel;
  status: CheckStatus;
  /** Human-readable evidence — what was observed, not just pass/fail. */
  detail: string;
}

/** Aggregate outcome of a suite run. */
export interface ConformanceReport {
  results: CheckResult[];
  passed: number;
  failed: number;
  skipped: number;
  /** True when no Core check failed. Skips do not block Core conformance. */
  coreConformant: boolean;
  /** True when no check of either level failed and none were skipped. */
  fullConformant: boolean;
}

/**
 * Everything a run needs beyond the probe itself. Two identities are required
 * because MEC-13 — the isolation check that carries the sovereignty guarantee —
 * is meaningless with only one.
 */
export interface ConformanceContext {
  /** Primary test identity. */
  userA: { invocation: string; roomId: string };
  /**
   * Second identity, in a different partition. When absent, MEC-13 is
   * reported as `skip` — and a skipped MEC-13 must be treated as a red flag,
   * not a pass.
   */
  userB?: { invocation: string; roomId: string };
  /** An invocation that has already expired, for MEC-05. */
  expiredInvocation?: string;
  /** Oracle DID(s) for REST batch queries. */
  oracleDids: string[];
  /**
   * Unique-per-run token embedded in written memories so the round-trip check
   * cannot pass on a pre-existing record.
   */
  runToken: string;
}

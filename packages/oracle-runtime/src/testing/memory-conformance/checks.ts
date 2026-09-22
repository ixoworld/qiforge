/**
 * Memory Engine Contract v1 — the conformance checks (MEC-01 … MEC-17).
 *
 * Pure functions over a {@link MemoryEngineProbe}. No test framework, no
 * assertion library, no global state — a check returns a {@link CheckResult}
 * describing what it observed. That keeps the suite usable from a vitest file,
 * a CI script, or an implementer's own harness without adopting our tooling.
 *
 * Every check is written to fail closed: an unexpected transport error is a
 * `fail`, never a silent `pass`. A check that cannot run for want of fixture
 * data returns `skip` with the reason, and the report treats an unmet Core
 * skip as non-conformance for Full (see `runConformance`).
 *
 * Spec: `specs/memory-engine-contract-v1.md` §10.
 */
import {
  ONTOLOGY_SAMPLE,
  REQUIRED_TOOLS,
  SEARCH_STRATEGIES,
  type CheckResult,
  type ConformanceContext,
  type ConformanceReport,
  type MemoryEngineProbe,
  type ProbeAuth,
  type ProbeOutcome,
} from './types.js';

// ─── result helpers ──────────────────────────────────────────────────────────

interface CheckMeta {
  id: string;
  title: string;
  section: string;
  level: 'core' | 'full';
}

const pass = (meta: CheckMeta, detail: string): CheckResult => ({
  ...meta,
  status: 'pass',
  detail,
});

const fail = (meta: CheckMeta, detail: string): CheckResult => ({
  ...meta,
  status: 'fail',
  detail,
});

const skip = (meta: CheckMeta, detail: string): CheckResult => ({
  ...meta,
  status: 'skip',
  detail,
});

/** Render an outcome for a failure message without dumping a whole payload. */
function describe(outcome: ProbeOutcome<unknown>): string {
  return outcome.ok
    ? 'succeeded'
    : `rejected (status=${outcome.status ?? 'none'}: ${outcome.error})`;
}

/** Contract §8: auth failures are 401/403. */
function isAuthRejection(outcome: ProbeOutcome<unknown>): boolean {
  return !outcome.ok && (outcome.status === 401 || outcome.status === 403);
}

/**
 * Serialize an arbitrary tool result for substring matching. Engines are free
 * to shape results as they like (§1), so retrieval checks look for a token
 * anywhere in the payload rather than assuming a field path.
 */
function flatten(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value ?? '');
  } catch {
    return '';
  }
}

/**
 * A retrieval probe is two distinct tokens, and the split is load-bearing.
 *
 * Engines commonly echo the request back in the response envelope (`query`,
 * `strategy_used`, …). If the string we search for is also the string we
 * assert on, that echo alone satisfies the assertion — so a *leak* check would
 * report leakage on a perfectly isolated engine, and a *retrieval* check would
 * pass on an engine that stored nothing.
 *
 * `term` goes in the query and may be echoed freely. `secret` appears only in
 * stored content, so finding it in a response proves the engine actually
 * returned stored data.
 */
interface RetrievalProbe {
  term: string;
  secret: string;
  content: string;
}

function retrievalProbe(runToken: string, label: string): RetrievalProbe {
  const term = `${label}-${runToken}`;
  const secret = `secret-${label}-${runToken}-payload`;
  return {
    term,
    secret,
    content: `Conformance probe ${term}. Stored payload: ${secret}`,
  };
}

const authOf = (id: { invocation: string; roomId: string }): ProbeAuth => ({
  invocation: id.invocation,
  roomId: id.roomId,
});

// ─── §2 transport ────────────────────────────────────────────────────────────

const MEC01: CheckMeta = {
  id: 'MEC-01',
  title: 'MCP endpoint completes tools/list',
  section: '§2',
  level: 'core',
};

export async function checkToolsList(
  probe: MemoryEngineProbe,
  ctx: ConformanceContext,
): Promise<CheckResult> {
  const outcome = await probe.listTools(authOf(ctx.userA));
  if (!outcome.ok) return fail(MEC01, `tools/list ${describe(outcome)}`);
  return pass(MEC01, `listed ${outcome.value.length} tool(s)`);
}

const MEC02: CheckMeta = {
  id: 'MEC-02',
  title: 'All six tools present under exact wire names',
  section: '§5',
  level: 'core',
};

export async function checkRequiredTools(
  probe: MemoryEngineProbe,
  ctx: ConformanceContext,
): Promise<CheckResult> {
  const outcome = await probe.listTools(authOf(ctx.userA));
  if (!outcome.ok) return fail(MEC02, `tools/list ${describe(outcome)}`);

  const names = new Set(outcome.value.map((t) => t.name));
  const missing = REQUIRED_TOOLS.filter((t) => !names.has(t));
  if (missing.length > 0) {
    return fail(MEC02, `missing tool(s): ${missing.join(', ')}`);
  }

  // Descriptions reach the agent verbatim (§5). An empty one is a real defect:
  // the model gets a nameless capability and cannot decide when to use it.
  const undescribed = outcome.value
    .filter((t) =>
      REQUIRED_TOOLS.includes(t.name as (typeof REQUIRED_TOOLS)[number]),
    )
    .filter((t) => t.description.trim().length === 0)
    .map((t) => t.name);
  if (undescribed.length > 0) {
    return fail(
      MEC02,
      `tool(s) with empty description: ${undescribed.join(', ')}`,
    );
  }

  return pass(MEC02, `all ${REQUIRED_TOOLS.length} required tools present`);
}

const MEC03: CheckMeta = {
  id: 'MEC-03',
  title: 'Tool definitions stable across consecutive lists',
  section: '§2',
  level: 'core',
};

export async function checkToolStability(
  probe: MemoryEngineProbe,
  ctx: ConformanceContext,
): Promise<CheckResult> {
  const auth = authOf(ctx.userA);
  const first = await probe.listTools(auth);
  const second = await probe.listTools(auth);
  if (!first.ok || !second.ok) {
    return fail(
      MEC03,
      `a tools/list call failed: ${describe(first.ok ? second : first)}`,
    );
  }

  const key = (list: { name: string; description: string }[]): string =>
    list
      .map((t) => `${t.name}:${t.description}`)
      .sort()
      .join('|');

  if (key(first.value) !== key(second.value)) {
    return fail(
      MEC03,
      'definitions differed between two consecutive lists — the runtime caches ' +
        'defs for 5min and would serve a stale contract',
    );
  }
  return pass(MEC03, 'definitions identical across two lists');
}

// ─── §3 auth ─────────────────────────────────────────────────────────────────

const MEC04: CheckMeta = {
  id: 'MEC-04',
  title: 'Request without an invocation is rejected',
  section: '§3.1',
  level: 'core',
};

export async function checkUnauthenticatedRejected(
  probe: MemoryEngineProbe,
  ctx: ConformanceContext,
): Promise<CheckResult> {
  const outcome = await probe.callTool(
    'search_memory_engine',
    { query: 'conformance', strategy: 'balanced' },
    { invocation: null, roomId: ctx.userA.roomId },
  );
  if (outcome.ok) {
    return fail(
      MEC04,
      'unauthenticated search succeeded — memory is readable without a UCAN',
    );
  }
  if (!isAuthRejection(outcome)) {
    return fail(MEC04, `rejected, but not with 401/403: ${describe(outcome)}`);
  }
  return pass(MEC04, `rejected with ${outcome.status}`);
}

const MEC05: CheckMeta = {
  id: 'MEC-05',
  title: 'Request with an expired invocation is rejected',
  section: '§3.1',
  level: 'core',
};

export async function checkExpiredRejected(
  probe: MemoryEngineProbe,
  ctx: ConformanceContext,
): Promise<CheckResult> {
  if (!ctx.expiredInvocation) {
    return skip(
      MEC05,
      'no expiredInvocation supplied in the conformance context',
    );
  }
  const outcome = await probe.callTool(
    'search_memory_engine',
    { query: 'conformance', strategy: 'balanced' },
    { invocation: ctx.expiredInvocation, roomId: ctx.userA.roomId },
  );
  if (outcome.ok) {
    return fail(
      MEC05,
      'expired invocation was accepted — expiry is not enforced',
    );
  }
  if (!isAuthRejection(outcome)) {
    return fail(MEC05, `rejected, but not with 401/403: ${describe(outcome)}`);
  }
  return pass(MEC05, `rejected with ${outcome.status}`);
}

const MEC06: CheckMeta = {
  id: 'MEC-06',
  title: 'Request with a valid invocation is accepted',
  section: '§3.1',
  level: 'core',
};

export async function checkValidAccepted(
  probe: MemoryEngineProbe,
  ctx: ConformanceContext,
): Promise<CheckResult> {
  const outcome = await probe.callTool(
    'search_memory_engine',
    { query: 'conformance', strategy: 'balanced' },
    authOf(ctx.userA),
  );
  if (!outcome.ok) return fail(MEC06, `valid invocation ${describe(outcome)}`);
  return pass(MEC06, 'accepted');
}

const MEC07: CheckMeta = {
  id: 'MEC-07',
  title: 'Missing x-room-id is rejected',
  section: '§3.3',
  level: 'core',
};

export async function checkRoomIdRequired(
  probe: MemoryEngineProbe,
  ctx: ConformanceContext,
): Promise<CheckResult> {
  const outcome = await probe.callTool(
    'search_memory_engine',
    { query: 'conformance', strategy: 'balanced' },
    { invocation: ctx.userA.invocation, roomId: null },
  );
  if (outcome.ok) {
    return fail(
      MEC07,
      'call succeeded without x-room-id — the engine is inferring the partition, ' +
        'which §3.3 forbids',
    );
  }
  return pass(MEC07, `rejected (status=${outcome.status ?? 'none'})`);
}

// ─── §5 semantics ────────────────────────────────────────────────────────────

const MEC08: CheckMeta = {
  id: 'MEC-08',
  title: 'add_memory → search_memory_engine round-trips',
  section: '§5.1–5.2',
  level: 'core',
};

export async function checkRoundTrip(
  probe: MemoryEngineProbe,
  ctx: ConformanceContext,
): Promise<CheckResult> {
  const auth = authOf(ctx.userA);
  const probeData = retrievalProbe(ctx.runToken, 'roundtrip');

  const write = await probe.callTool(
    'add_memory',
    {
      name: `Conformance probe ${ctx.runToken}`,
      content: probeData.content,
      source: 'text',
      source_description: 'memory-engine conformance suite',
    },
    auth,
  );
  if (!write.ok) return fail(MEC08, `add_memory ${describe(write)}`);

  const read = await probe.callTool(
    'search_memory_engine',
    { query: probeData.term, strategy: 'balanced', knowledge_level: 'user' },
    auth,
  );
  if (!read.ok) return fail(MEC08, `search ${describe(read)}`);

  if (!flatten(read.value).includes(probeData.secret)) {
    return fail(
      MEC08,
      `wrote a memory containing "${probeData.secret}" and searched for ` +
        `"${probeData.term}", but the stored payload was not in the response — ` +
        'engines with asynchronous extraction may need an ingest delay',
    );
  }
  return pass(MEC08, `stored payload retrieved via query "${probeData.term}"`);
}

const MEC09: CheckMeta = {
  id: 'MEC-09',
  title: 'All eight search strategies accepted',
  section: '§7.3',
  level: 'core',
};

export async function checkStrategies(
  probe: MemoryEngineProbe,
  ctx: ConformanceContext,
): Promise<CheckResult> {
  const auth = authOf(ctx.userA);
  const rejected: string[] = [];

  for (const strategy of SEARCH_STRATEGIES) {
    // `contextual` requires a centre node (§7.3); without one a rejection is
    // correct behaviour, so it is exercised separately and not counted here.
    if (strategy === 'contextual') continue;
    const outcome = await probe.callTool(
      'search_memory_engine',
      { query: 'conformance', strategy },
      auth,
    );
    if (!outcome.ok) rejected.push(`${strategy} (${outcome.error})`);
  }

  if (rejected.length > 0) {
    return fail(MEC09, `strategies rejected: ${rejected.join('; ')}`);
  }
  return pass(
    MEC09,
    `${SEARCH_STRATEGIES.length - 1} strategies accepted (contextual excluded)`,
  );
}

const MEC10: CheckMeta = {
  id: 'MEC-10',
  title: 'Bi-temporal filter groups accepted; no match yields empty, not error',
  section: '§5.1',
  level: 'core',
};

export async function checkTemporalFilters(
  probe: MemoryEngineProbe,
  ctx: ConformanceContext,
): Promise<CheckResult> {
  const auth = authOf(ctx.userA);

  // (created_at >= 1970 OR created_at IS NULL) AND (created_at <= now)
  const satisfiable = await probe.callTool(
    'search_memory_engine',
    {
      query: 'conformance',
      strategy: 'balanced',
      created_at: [
        [
          { date: '1970-01-01T00:00:00Z', comparison_operator: '>=' },
          { comparison_operator: 'IS NULL' },
        ],
        [
          {
            date: new Date(Date.now() + 86_400_000).toISOString(),
            comparison_operator: '<=',
          },
        ],
      ],
    },
    auth,
  );
  if (!satisfiable.ok) {
    return fail(MEC10, `satisfiable temporal filter ${describe(satisfiable)}`);
  }

  // A window that cannot match anything must return empty, not error (§5.1).
  const unsatisfiable = await probe.callTool(
    'search_memory_engine',
    {
      query: 'conformance',
      strategy: 'balanced',
      created_at: [
        [{ date: '1900-01-01T00:00:00Z', comparison_operator: '<' }],
      ],
    },
    auth,
  );
  if (!unsatisfiable.ok) {
    return fail(
      MEC10,
      `filter matching nothing ${describe(unsatisfiable)} — §5.1 requires an empty result`,
    );
  }
  return pass(
    MEC10,
    'AND-of-OR groups accepted; empty match returned a result envelope',
  );
}

const MEC11: CheckMeta = {
  id: 'MEC-11',
  title: 'Destructive tools reject a missing or false confirmation flag',
  section: '§5.6',
  level: 'core',
};

export async function checkConfirmationInterlock(
  probe: MemoryEngineProbe,
  ctx: ConformanceContext,
): Promise<CheckResult> {
  const auth = authOf(ctx.userA);
  const accepted: string[] = [];

  const cases: Array<{ tool: string; args: Record<string, unknown> }> = [
    { tool: 'clear', args: {} },
    { tool: 'clear', args: { confirmed_deletion_from_user: false } },
    { tool: 'delete_episode', args: { episode_uuid: `probe-${ctx.runToken}` } },
    {
      tool: 'delete_edge',
      args: {
        edge_uuid: `probe-${ctx.runToken}`,
        confirmed_deletion_from_user: false,
      },
    },
    {
      tool: 'add_oracle_knowledge',
      args: {
        name: `probe-${ctx.runToken}`,
        content: 'unconfirmed write',
        knowledge_space_type: 'private',
      },
    },
  ];

  for (const { tool, args } of cases) {
    const outcome = await probe.callTool(tool, args, auth);
    if (outcome.ok) accepted.push(`${tool}(${JSON.stringify(args)})`);
  }

  if (accepted.length > 0) {
    return fail(
      MEC11,
      `unconfirmed call(s) accepted: ${accepted.join(', ')} — the safety interlock is not enforced`,
    );
  }
  return pass(MEC11, `all ${cases.length} unconfirmed calls rejected`);
}

const MEC12: CheckMeta = {
  id: 'MEC-12',
  title: 'knowledge_level scoping separates user and oracle space',
  section: '§4',
  level: 'core',
};

export async function checkKnowledgeLevelScoping(
  probe: MemoryEngineProbe,
  ctx: ConformanceContext,
): Promise<CheckResult> {
  const auth = authOf(ctx.userA);
  const probeData = retrievalProbe(ctx.runToken, 'scoping');

  const write = await probe.callTool(
    'add_memory',
    { name: `Scoping probe ${ctx.runToken}`, content: probeData.content },
    auth,
  );
  if (!write.ok) return fail(MEC12, `add_memory ${describe(write)}`);

  const inUser = await probe.callTool(
    'search_memory_engine',
    { query: probeData.term, strategy: 'balanced', knowledge_level: 'user' },
    auth,
  );
  if (!inUser.ok) return fail(MEC12, `user-scoped search ${describe(inUser)}`);
  if (!flatten(inUser.value).includes(probeData.secret)) {
    return fail(
      MEC12,
      'user-space write was not visible at knowledge_level=user',
    );
  }

  const inOracle = await probe.callTool(
    'search_memory_engine',
    { query: probeData.term, strategy: 'balanced', knowledge_level: 'oracle' },
    auth,
  );
  if (!inOracle.ok)
    return fail(MEC12, `oracle-scoped search ${describe(inOracle)}`);
  if (flatten(inOracle.value).includes(probeData.secret)) {
    return fail(
      MEC12,
      'a user-space memory surfaced at knowledge_level=oracle — private memory ' +
        'is leaking into the shared space',
    );
  }
  return pass(
    MEC12,
    'user-space write visible to user scope and absent from oracle scope',
  );
}

const MEC13: CheckMeta = {
  id: 'MEC-13',
  title: 'Cross-user isolation — user B never sees user A memory',
  section: '§4',
  level: 'core',
};

/**
 * The sovereignty check. A shared-database engine that partitions by a
 * caller-supplied field rather than the verified invocation issuer fails here,
 * and this is the single check whose failure invalidates the whole contract
 * regardless of every other result.
 */
export async function checkCrossUserIsolation(
  probe: MemoryEngineProbe,
  ctx: ConformanceContext,
): Promise<CheckResult> {
  if (!ctx.userB) {
    return skip(
      MEC13,
      'no second identity supplied — isolation is UNVERIFIED. Treat this as a ' +
        'red flag, not a pass: supply userB before claiming conformance',
    );
  }

  const probeData = retrievalProbe(ctx.runToken, 'isolation');
  const write = await probe.callTool(
    'add_memory',
    { name: `Isolation probe ${ctx.runToken}`, content: probeData.content },
    authOf(ctx.userA),
  );
  if (!write.ok) return fail(MEC13, `user A add_memory ${describe(write)}`);

  // Confirm the write is actually retrievable by its owner. Without this, an
  // engine that silently dropped the write would pass isolation vacuously.
  const ownerRead = await probe.callTool(
    'search_memory_engine',
    { query: probeData.term, strategy: 'balanced', knowledge_level: 'user' },
    authOf(ctx.userA),
  );
  if (!ownerRead.ok || !flatten(ownerRead.value).includes(probeData.secret)) {
    return fail(
      MEC13,
      'user A could not read back their own write — isolation cannot be verified ' +
        'against a memory that was never stored',
    );
  }

  for (const level of ['user', 'oracle', 'both'] as const) {
    const read = await probe.callTool(
      'search_memory_engine',
      { query: probeData.term, strategy: 'balanced', knowledge_level: level },
      authOf(ctx.userB),
    );
    // A rejection is acceptable here; leakage is not.
    if (read.ok && flatten(read.value).includes(probeData.secret)) {
      return fail(
        MEC13,
        `user B retrieved user A's private payload at knowledge_level=${level} — ` +
          'CROSS-USER LEAKAGE. Non-conformant regardless of other results',
      );
    }
  }

  // Also prove B cannot reach A's partition by supplying A's room id.
  const crossRoom = await probe.callTool(
    'search_memory_engine',
    { query: probeData.term, strategy: 'balanced', knowledge_level: 'both' },
    { invocation: ctx.userB.invocation, roomId: ctx.userA.roomId },
  );
  if (crossRoom.ok && flatten(crossRoom.value).includes(probeData.secret)) {
    return fail(
      MEC13,
      "user B reached user A's partition by supplying A's room id — the partition " +
        'key trusts the header over the invocation issuer',
    );
  }

  return pass(
    MEC13,
    "user A read back their own write; user B could not, at any scope or via A's room id",
  );
}

const MEC14: CheckMeta = {
  id: 'MEC-14',
  title: 'Documented entity/edge filter values are accepted',
  section: '§7.1–7.2',
  level: 'core',
};

export async function checkOntologyAccepted(
  probe: MemoryEngineProbe,
  ctx: ConformanceContext,
): Promise<CheckResult> {
  const outcome = await probe.callTool(
    'search_memory_engine',
    {
      query: 'conformance',
      strategy: 'balanced',
      node_labels: [...ONTOLOGY_SAMPLE.nodeLabels],
      edge_types: [...ONTOLOGY_SAMPLE.edgeTypes],
    },
    authOf(ctx.userA),
  );
  if (!outcome.ok) {
    return fail(
      MEC14,
      `documented ontology values ${describe(outcome)} — the sample includes the ` +
        'IXO/Qi types (Claim, VerifiableCredential, SUBMITS_CLAIM, TRIGGERS_PAYMENT)',
    );
  }
  return pass(MEC14, 'personal + IXO/Qi entity and edge filters accepted');
}

// ─── §6 REST ─────────────────────────────────────────────────────────────────

const MEC15: CheckMeta = {
  id: 'MEC-15',
  title: 'Batch returns one ordered slot per query',
  section: '§6.1',
  level: 'full',
};

export async function checkBatchArity(
  probe: MemoryEngineProbe,
  ctx: ConformanceContext,
): Promise<CheckResult> {
  if (!probe.searchBatch) {
    return skip(
      MEC15,
      'probe does not implement searchBatch (Core-only engine)',
    );
  }
  const queries = ['identity', 'work', 'goals'].map((q) => ({
    oracle_dids: ctx.oracleDids,
    query: q,
    strategy: 'balanced',
  }));

  const outcome = await probe.searchBatch(queries, authOf(ctx.userA));
  if (!outcome.ok) return fail(MEC15, `batch ${describe(outcome)}`);

  const { results } = outcome.value;
  if (!Array.isArray(results)) {
    return fail(MEC15, 'response has no `results` array');
  }
  if (results.length !== queries.length) {
    return fail(
      MEC15,
      `sent ${queries.length} queries, got ${results.length} slots — the caller maps ` +
        'slots to userContext fields positionally, so a mismatch corrupts every field',
    );
  }
  return pass(MEC15, `${results.length} slots for ${queries.length} queries`);
}

const MEC16: CheckMeta = {
  id: 'MEC-16',
  title: 'A failing query yields an error slot, not a failed batch',
  section: '§6.1',
  level: 'full',
};

export async function checkBatchPartialFailure(
  probe: MemoryEngineProbe,
  ctx: ConformanceContext,
): Promise<CheckResult> {
  if (!probe.searchBatch) {
    return skip(
      MEC16,
      'probe does not implement searchBatch (Core-only engine)',
    );
  }

  // `contextual` without `center_node_uuid` is the documented way to make one
  // slot fail (§7.3) while its neighbours remain valid.
  const queries = [
    { oracle_dids: ctx.oracleDids, query: 'valid', strategy: 'balanced' },
    { oracle_dids: ctx.oracleDids, query: 'invalid', strategy: 'contextual' },
    { oracle_dids: ctx.oracleDids, query: 'valid too', strategy: 'balanced' },
  ];

  const outcome = await probe.searchBatch(queries, authOf(ctx.userA));
  if (!outcome.ok) {
    return fail(
      MEC16,
      `whole batch ${describe(outcome)} — one bad query must not fail the request`,
    );
  }
  if (outcome.value.results.length !== queries.length) {
    return fail(
      MEC16,
      `expected ${queries.length} slots, got ${outcome.value.results.length}`,
    );
  }

  const errorSlots = outcome.value.results.filter(
    (slot) => typeof slot.error === 'object' && slot.error !== null,
  );
  if (errorSlots.length === 0) {
    return pass(
      MEC16,
      'batch survived a malformed query and returned full arity (engine tolerated ' +
        'the query rather than erroring the slot — acceptable)',
    );
  }
  return pass(
    MEC16,
    `${errorSlots.length} error slot(s) returned; batch arity preserved`,
  );
}

const MEC17: CheckMeta = {
  id: 'MEC-17',
  title: 'POST /messages accepts the documented shape',
  section: '§6.2',
  level: 'full',
};

export async function checkIngest(
  probe: MemoryEngineProbe,
  ctx: ConformanceContext,
): Promise<CheckResult> {
  if (!probe.postMessages) {
    return skip(
      MEC17,
      'probe does not implement postMessages (Core-only engine)',
    );
  }
  const outcome = await probe.postMessages(
    [
      {
        content: `Conformance ingest ${ctx.runToken}`,
        role_type: 'user',
        role: 'Conformance User',
        name: 'Conformance User',
        source_description: 'memory-engine conformance suite',
      },
      {
        content: 'Acknowledged.',
        role_type: 'assistant',
        role: 'Conformance Oracle',
        name: 'Conformance Oracle',
        source_description: 'memory-engine conformance suite',
      },
    ],
    authOf(ctx.userA),
  );
  if (!outcome.ok) return fail(MEC17, `ingest ${describe(outcome)}`);
  return pass(
    MEC17,
    'accepted a two-message batch with real speaker identities',
  );
}

// ─── runner ──────────────────────────────────────────────────────────────────

/** Every check, in spec order. */
export const ALL_CHECKS = [
  checkToolsList,
  checkRequiredTools,
  checkToolStability,
  checkUnauthenticatedRejected,
  checkExpiredRejected,
  checkValidAccepted,
  checkRoomIdRequired,
  checkRoundTrip,
  checkStrategies,
  checkTemporalFilters,
  checkConfirmationInterlock,
  checkKnowledgeLevelScoping,
  checkCrossUserIsolation,
  checkOntologyAccepted,
  checkBatchArity,
  checkBatchPartialFailure,
  checkIngest,
] as const;

/**
 * Run the full suite and aggregate. Checks run sequentially: several write and
 * then read the same partition, and interleaving them would make a failure
 * ambiguous between "not stored" and "raced".
 *
 * A check that throws is recorded as a failure rather than aborting the run —
 * a partial report is more useful than a stack trace.
 */
export async function runConformance(
  probe: MemoryEngineProbe,
  ctx: ConformanceContext,
): Promise<ConformanceReport> {
  const results: CheckResult[] = [];

  for (const check of ALL_CHECKS) {
    try {
      results.push(await check(probe, ctx));
    } catch (err) {
      results.push({
        id: check.name,
        title: check.name,
        section: '—',
        level: 'core',
        status: 'fail',
        detail: `check threw: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skip').length;

  return {
    results,
    passed,
    failed,
    skipped,
    coreConformant: !results.some(
      (r) => r.level === 'core' && r.status === 'fail',
    ),
    fullConformant: failed === 0 && skipped === 0,
  };
}

/** Render a report as a fixed-width table for CI logs. */
export function formatReport(report: ConformanceReport): string {
  const icon = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' } as const;
  const lines = report.results.map(
    (r) =>
      `  ${icon[r.status]}  ${r.id.padEnd(7)} ${r.section.padEnd(9)} ${r.title}\n           ${r.detail}`,
  );
  return [
    'Memory Engine Contract v1 — conformance report',
    ...lines,
    '',
    `  ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped`,
    `  Core conformant: ${report.coreConformant ? 'yes' : 'NO'}`,
    `  Full conformant: ${report.fullConformant ? 'yes' : 'no'}`,
  ].join('\n');
}

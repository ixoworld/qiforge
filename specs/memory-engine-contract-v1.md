# Memory Engine Contract v1 — `ixo:memory`

**Version:** 1.0.0-draft
**Status:** Normative. Derived from the behaviour the QiForge runtime already depends on.
**Conformance suite:** `@ixo/oracle-runtime/testing/memory-conformance`
**Related:** [`memory-sovereignty-architecture.md`](./memory-sovereignty-architecture.md) — this document is that proposal's Tier 0.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be interpreted as described in RFC 2119.

---

## Table of Contents

1. [Purpose and scope](#1-purpose-and-scope)
2. [Transport and endpoints](#2-transport-and-endpoints)
3. [Authentication](#3-authentication)
4. [Partitioning and isolation](#4-partitioning-and-isolation)
5. [MCP tool surface](#5-mcp-tool-surface)
6. [REST surface](#6-rest-surface)
7. [Ontology](#7-ontology)
8. [Error semantics](#8-error-semantics)
9. [Degradation contract](#9-degradation-contract)
10. [Conformance](#10-conformance)
11. [Known drift in the current implementation](#11-known-drift-in-the-current-implementation)

---

## 1. Purpose and scope

A **Memory Engine** is any service that provides durable, per-user, bi-temporal memory to a QiForge oracle. This document specifies the interface exactly and completely, so that:

- an oracle operator MAY run their own engine and point `MEMORY_MCP_URL` / `MEMORY_ENGINE_URL` at it;
- an implementer MAY build an engine on any storage backend without reading QiForge source;
- conformance is machine-checkable rather than a matter of opinion.

**This is the federation primitive.** Federation here is a property of the protocol — many independent implementations interoperating — not of a clustered database.

Out of scope: how memories are extracted, how the graph is stored, ranking internals, and embedding models. Those are implementation choices this contract deliberately does not constrain.

### 1.1 Conformance levels

| Level    | Requirement                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------ |
| **Core** | §2, §3, §4, §5 (all six tools), §8. An engine that passes Core can serve the `memory` plugin.    |
| **Full** | Core + §6 (both REST endpoints). Required for `userContext` pre-warming and conversation ingest. |

An engine MAY implement Core only. The runtime degrades cleanly without the REST surface (§9) — `MEMORY_ENGINE_URL` is optional in `messages.module.ts` and `sessions.module.ts`.

---

## 2. Transport and endpoints

An engine exposes two base URLs. They MAY be the same host.

| Config key          | Surface                                     | Required for |
| ------------------- | ------------------------------------------- | ------------ |
| `MEMORY_MCP_URL`    | Model Context Protocol over streamable HTTP | Core         |
| `MEMORY_ENGINE_URL` | JSON over HTTP                              | Full         |

**MCP.** The engine MUST implement MCP over HTTP such that a standard client can complete initialization and `tools/list`. The runtime connects with `@langchain/mcp-adapters`' `MultiServerMCPClient` using `type: 'http'`, `transport: 'http'`, and `prefixToolNameWithServerName: true` under the server name `memory-engine`. Tool names therefore appear to the agent as `memory-engine__<tool>`; the **wire** names are unprefixed and are what this document specifies.

The engine MUST tolerate a client that connects, calls `tools/list`, and disconnects without invoking a tool — the runtime does exactly this to cache tool definitions.

Tool definitions MUST be stable between deploys. The runtime caches them for 5 minutes and serves stale definitions during a background refresh, so a definition that changes shape mid-window will surface as an invoke-time error.

---

## 3. Authentication

### 3.1 UCAN (normative)

Every request MUST carry a UCAN invocation:

```http
Authorization: Bearer <serialized-ucan-invocation>
X-Auth-Type: ucan
x-room-id: <matrix-room-id>
```

The engine MUST verify:

1. The invocation's signature.
2. That it has not expired.
3. That the claimed capability is `ixo:memory` with an ability satisfying `memory/*`.
4. That the proof chain roots in an issuer the engine trusts.

The engine's own DID MUST be resolvable via `did:web` at the `MEMORY_MCP_URL` host, because the runtime resolves the audience DID that way before minting (`plugins/memory/memory-ucan.ts`).

An engine MUST NOT accept a request whose invocation is absent, malformed, expired, or claims an ability outside `memory/*`. It MUST reject with `401` or `403` (§8).

> **Ability matching is literal.** `@ixo/ucan` compares the `can` string directly — a `'*'` claim is _not_ satisfied by a `memory/*` grant, which is why the runtime claims `memory/*` explicitly. Implementations MUST match this behaviour.

### 3.2 Matrix OpenID (deprecated)

`@ixo/common`'s `MemoryEngineService` still supports a legacy header set (`x-oracle-token`, `x-user-token`, `x-oracle-matrix-homeserver`, `x-user-matrix-homeserver`). A v1-conformant engine MUST NOT require it and SHOULD NOT accept it. It is documented here only so implementers recognise it in traffic from older callers.

### 3.3 `x-room-id`

`x-room-id` MUST be present on every request and identifies the Matrix room scoping the call. The engine MUST treat it as part of the partition key (§4). An engine MUST NOT infer the room from the invocation alone.

---

## 4. Partitioning and isolation

Memory is partitioned by `group_id`, derived from the **(user, oracle)** pair. The user identity MUST be taken from the verified invocation's issuer DID — never from a request body field, which is caller-controlled.

Two spaces exist per partition:

| Space      | Scope                                  | Written by             |
| ---------- | -------------------------------------- | ---------------------- |
| **user**   | One user, one oracle. Private.         | `add_memory`           |
| **oracle** | Shared across all users of one oracle. | `add_oracle_knowledge` |

**Isolation requirements — these are the sovereignty guarantees:**

- **MEC-13.** An engine MUST NOT return any user-space content belonging to user A in a response to a request authenticated as user B, under any `knowledge_level`, strategy, or filter combination.
- An engine MUST NOT return oracle-space content of oracle X to a request scoped to oracle Y.
- `clear` MUST affect only the calling partition.

An engine that cannot enforce the first requirement is non-conformant regardless of every other behaviour.

---

## 5. MCP tool surface

Six tools. An engine MUST expose all six under exactly these wire names.

| Wire name              | Purpose                       | Level |
| ---------------------- | ----------------------------- | ----- |
| `search_memory_engine` | Hybrid retrieval              | Core  |
| `add_memory`           | Write a user-space episode    | Core  |
| `add_oracle_knowledge` | Write an oracle-space episode | Core  |
| `delete_episode`       | Remove one episode            | Core  |
| `delete_edge`          | Remove one edge               | Core  |
| `clear`                | Wipe the calling partition    | Core  |

Tool `description` strings are the engine's own and are passed to the agent **verbatim** — the runtime does not rewrite them (`plugins/memory/memory-tools.ts`). Implementers own their prompt-facing wording.

### 5.1 `search_memory_engine`

```ts
{
  query: string;                       // required
  strategy: SearchStrategy;            // required — see §7.3
  knowledge_level?: 'user' | 'oracle' | 'both';   // default 'both'
  center_node_uuid?: string;           // traversal centre; required by strategy 'contextual'
  node_labels?: EntityType[];
  edge_types?: EdgeType[];
  valid_at?: DateFilterGroups;
  invalid_at?: DateFilterGroups;
  created_at?: DateFilterGroups;
  expired_at?: DateFilterGroups;
}
```

`DateFilterGroups` is `DateFilter[][]`, interpreted as **OR within a group, AND between groups**: `[[a, b], [c]]` means `(a OR b) AND c`.

```ts
interface DateFilter {
  date?: string; // ISO-8601; omitted for IS NULL / IS NOT NULL
  comparison_operator:
    | '='
    | '<>'
    | '>'
    | '<'
    | '>='
    | '<='
    | 'IS NULL'
    | 'IS NOT NULL';
}
```

The engine MUST accept every documented field and MUST NOT error on a filter that matches nothing — an empty result is the correct response.

### 5.2 `add_memory`

```ts
{ name: string; content: string; source?: string; source_description?: string }
```

Writes to **user space**. `source` defaults to `'text'`.

### 5.3 `add_oracle_knowledge`

```ts
{
  name: string;
  content: string;
  confirmed_insertion_from_user: boolean;   // MUST be true
  knowledge_space_type: 'public' | 'private';
  source?: string;
  source_description?: string;
}
```

Writes to **oracle space**. The engine MUST reject the call when `confirmed_insertion_from_user` is not `true`.

### 5.4 `delete_episode` / `delete_edge`

```ts
{
  episode_uuid: string;
  confirmed_deletion_from_user: boolean;
} // MUST be true
{
  edge_uuid: string;
  confirmed_deletion_from_user: boolean;
} // MUST be true
```

### 5.5 `clear`

```ts
{
  confirmed_deletion_from_user: boolean;
} // MUST be true
```

Wipes the calling partition's user space.

### 5.6 Confirmation flags are a safety interlock

For all four destructive/oracle-write tools, the engine MUST reject the call when the confirmation flag is absent or not exactly `true`. The flag exists so that a model cannot destroy memory without having emitted an explicit confirmation token; treating a missing flag as consent defeats it.

Rejection MUST be a tool error, not a silent no-op — a no-op reports success to the agent, which then tells the user their memory was deleted when it was not.

---

## 6. REST surface

Required for **Full** conformance only.

### 6.1 `POST /search-enhanced-batch`

```ts
// request
{ queries: SearchEnhancedRequest[] }

interface SearchEnhancedRequest {
  oracle_dids: string[];      // 1–5 items
  query: string;
  strategy?: SearchStrategy;              // default 'balanced'
  max_facts?: number;                     // default 10
  max_entities?: number;                  // default 5
  max_episodes?: number;                  // default 3
  max_communities?: number;               // default 2
  knowledge_level?: KnowledgeLevel;       // default 'both'
  center_node_uuid?: string | null;
  search_filters?: SearchFilters | null;
}
```

> **Note the asymmetry.** The REST surface nests filters under `search_filters`; the MCP surface takes them flat. Both are load-bearing today. v1 pins both shapes as-is; unifying them would be a v2 break.

```ts
// response
{ results: SearchEnhancedBatchSlot[] }

type SearchEnhancedBatchSlot = SearchEnhancedResponse | SearchEnhancedBatchErrorSlot;

interface SearchEnhancedResponse {
  strategy_used: string;
  query: string;
  total_results: { facts: number; entities: number; episodes: number; communities: number };
  facts: FactResult[];
  entities: EntityResult[];
  episodes: EpisodeResult[];
  communities: CommunityResult[];
}

interface SearchEnhancedBatchErrorSlot {
  error: { status_code: number; detail: string };
  query: string;
  strategy_used: string;
}
```

Requirements:

- `results` MUST have the same length as `queries`, in the same order. The caller maps slots to fields positionally (`identity`, `work`, `goals`, `interests`, `relationships`, `recent`) — a length mismatch silently corrupts every field.
- A single failing query MUST produce an error slot, not a failed request. Partial failure is the designed behaviour.
- The endpoint SHOULD respond within 30 s. The caller's soft deadline is 30 s and its hard abort is 60 s.

### 6.2 `POST /messages`

```ts
{
  messages: Array<{
    content: string;
    role_type: 'user' | 'assistant' | 'system';
    role?: string;
    name?: string;
    source_description?: string;
  }>;
}
```

Conversation history for extraction. `name` carries the **real speaker identity**, not `"user"`/`"assistant"` — an extractor that pins facts to a generic speaker node pollutes the graph. The engine SHOULD use `name` as the speaker entity.

Ingest MAY be asynchronous; a `2xx` means accepted, not necessarily extracted.

---

## 7. Ontology

### 7.1 Entity types

Personal: `Person`, `Trait`, `Value`, `Identity`, `Attribute`, `Emotion`, `Stress`, `CopingStrategy`, `Job`, `Project`, `Skill`, `Tool`, `Organization`, `Goal`, `Milestone`, `Habit`, `Routine`, `Pattern`, `Interest`, `Hobby`, `Content`, `Preference`, `Product`, `Expertise`, `LearningGoal`, `Resource`, `Location`, `Experience`, `Event`, `Group`, `Pet`, `CommunicationStyle`, `Language`, `Task`, `Belief`, `Cause`, `Procedure`.

IXO/Qi: `Agent`, `SmartAccount`, `OutcomeUnit`, `Claim`, `Evaluation`, `ServiceEvent`, `Payment`, `VerifiableCredential`.

### 7.2 Edge types

Personal: `Knows`, `WorksWith`, `Causes`, `Enables`, `Blocks`, `PartOf`, `BelongsTo`, `Practices`, `Uses`, `Pursuing`, `Requires`, `Achieved`, `EmployedAt`, `WorksOn`, `Manages`, `LivesAt`, `VisitedLocation`, `LocatedIn`, `Prefers`, `Likes`, `Dislikes`, `InterestedIn`, `ExpertiseIn`, `Studying`, `LearnedFrom`, `Triggers`, `Motivates`, `ManagesVia`, `Influences`, `Supports`, `MemberOf`, `Owns`, `CurrentlyIs`, `WasPreviously`, `AlignedWith`, `ConflictsWith`, `RelatesTo`.

IXO/Qi: `OWNS`, `CONTROLS`, `SUBMITS_CLAIM`, `HAS_EVALUATION`, `RESULTS_IN_OUTCOME`, `TRIGGERS_PAYMENT`, `PAYS_FOR_SERVICE`, `HAS_IDENTITY`.

An engine MUST accept all of these as filter values. It MAY extend both sets; it MUST NOT reject a documented value.

### 7.3 Search strategies

`balanced` (default), `diverse`, `precise`, `contextual`, `recent_memory`, `facts_only`, `entities_only`, `topics_only`.

Strategies are retrieval _hints_. An engine MUST accept all eight and SHOULD honour their intent, but ranking is an implementation choice. `contextual` requires `center_node_uuid`.

### 7.4 Bi-temporality

Four timestamps, and an engine MUST maintain all four:

| Field        | Meaning                                       |
| ------------ | --------------------------------------------- |
| `valid_at`   | When the fact became true in the world        |
| `invalid_at` | When it stopped being true                    |
| `created_at` | When the system learned it                    |
| `expired_at` | When the system learned it was no longer true |

Superseded facts MUST be invalidated, not deleted — `valid_at`/`invalid_at` are how "what did they believe last March" stays answerable. Only `delete_*` and `clear` remove data.

---

## 8. Error semantics

| Condition                                 | Status            |
| ----------------------------------------- | ----------------- |
| Missing / malformed / expired invocation  | `401`             |
| Valid invocation, insufficient capability | `403`             |
| Missing `x-room-id`                       | `400`             |
| Malformed body / unknown field value      | `400`             |
| Confirmation flag not `true`              | tool error (§5.6) |
| Backend unavailable                       | `503`             |

Errors MUST NOT leak another partition's content in messages.

MCP tool failures MUST surface as tool errors. An engine MUST NOT return a `2xx` success envelope describing a failure — the agent treats a success envelope as truth and will report it to the user.

---

## 9. Degradation contract

The runtime treats memory as **enrichment, never a dependency**. Implementers should know exactly how callers behave so they can reason about outages:

- `UserContextFetcher` waits 30 s (soft), aborts at 60 s (hard), negative-caches failures, and returns `undefined` on any failure. A turn proceeds without enrichment.
- `MemoryPlugin.getRequestTools()` returns `[]` when auth minting fails, so the agent simply sees no memory tools.
- `SessionHistoryProcessor` retries three times with a 10 s delay, holding a 5-minute per-session lock.

An engine SHOULD fail fast rather than hang. A 503 in 100 ms is better for users than a success in 45 s.

---

## 10. Conformance

The suite lives at `@ixo/oracle-runtime/testing/memory-conformance` and is transport-agnostic: it runs against any implementation of the `MemoryEngineProbe` interface. `HttpMemoryEngineProbe` speaks real MCP + REST.

| ID         | Check                                                           | Level | Spec     |
| ---------- | --------------------------------------------------------------- | ----- | -------- |
| MEC-01     | MCP endpoint completes `tools/list`                             | Core  | §2       |
| MEC-02     | All six tools present under exact wire names                    | Core  | §5       |
| MEC-03     | Tool definitions are stable across two consecutive lists        | Core  | §2       |
| MEC-04     | Request without an invocation is rejected                       | Core  | §3.1     |
| MEC-05     | Request with an expired invocation is rejected                  | Core  | §3.1     |
| MEC-06     | Request with a valid invocation is accepted                     | Core  | §3.1     |
| MEC-07     | Missing `x-room-id` is rejected                                 | Core  | §3.3     |
| MEC-08     | `add_memory` → `search_memory_engine` round-trips               | Core  | §5.1–5.2 |
| MEC-09     | All eight strategies accepted                                   | Core  | §7.3     |
| MEC-10     | Bi-temporal filter groups accepted; no match ⇒ empty, not error | Core  | §5.1     |
| MEC-11     | Destructive tools reject a missing/false confirmation flag      | Core  | §5.6     |
| MEC-12     | `knowledge_level` scoping separates user and oracle space       | Core  | §4       |
| **MEC-13** | **Cross-user isolation — user B never sees user A's memory**    | Core  | §4       |
| MEC-14     | Documented entity/edge filter values are accepted               | Core  | §7.1–7.2 |
| MEC-15     | Batch returns one ordered slot per query                        | Full  | §6.1     |
| MEC-16     | A failing query yields an error slot, not a failed batch        | Full  | §6.1     |
| MEC-17     | `POST /messages` accepts the documented shape                   | Full  | §6.2     |

Running against a live engine:

```bash
cd packages/oracle-runtime
# .env.integration must define MEMORY_MCP_URL, MEMORY_ENGINE_URL, ORACLE_DID,
# TEST_USER_MNEMONIC, TEST_USER_DID, TEST_ROOM_ID
# and, for MEC-13, TEST_USER_B_MNEMONIC / TEST_USER_B_DID
pnpm test:integration -- memory-conformance
```

The suite **throws on missing env** rather than skipping, per house rules. A skipped conformance check is indistinguishable from a passing one in CI, which defeats the purpose.

---

## 11. Known drift in the current implementation

Recorded during spec derivation. Each is a place where the codebase disagrees with itself; v1 pins the resolution.

| #   | Drift                                                                                                                                                         | v1 ruling                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `packages/common/src/services/memory-engine/types.ts` omits the eight IXO/Qi entity types and eight IXO/Qi edge types that `plugins/memory/types.ts` declares | The **plugin** list is normative (§7.1–7.2). `@ixo/common` needs updating; until then, REST callers cannot express IXO/Qi filters that MCP callers can |
| 2   | MCP takes filters flat; REST nests them under `search_filters`                                                                                                | Both pinned as-is. Unifying is a v2 break                                                                                                              |
| 3   | `DateFilter.date` is optional in the plugin types, `string \| null` in `@ixo/common`                                                                          | Engines MUST accept absent, `null`, and ISO-8601                                                                                                       |
| 4   | `DEFAULT_MEMORY_TOOLS` exposes four of six tools; `add_oracle_knowledge` and `delete_edge` are opt-in for forks                                               | Contract covers all six; exposure is a **fork policy** decision, not an engine one                                                                     |
| 5   | Legacy Matrix-OpenID auth still live in `@ixo/common`                                                                                                         | Deprecated (§3.2). Retire once no caller uses it                                                                                                       |

Item 1 is the one with user-visible consequence: an oracle cannot currently filter `userContext` pre-warm queries by `Claim` or `VerifiableCredential`, though the agent can filter by them mid-conversation.

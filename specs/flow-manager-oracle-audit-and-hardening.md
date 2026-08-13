# Flow Manager oracle — code audit, flow-creation alignment, and production hardening

**Subject:** `ixoworld/flow-manager-oracle` @ `81d3b1a` (shallow clone, `main`).
**Companions:** `specs/flows-plugin-lifecycle-audit.md`, `specs/flow-recipe-lifecycle-design.md`.
**Method:** static read of the repo. **The test suite was not executed** — the monorepo needs a
full `pnpm install` against private registries, which this environment cannot complete. Every
finding below is sourced to a file and symbol; none depends on a test run.

---

## Part 1 — Code audit

### 1.1 Shape

| Area                            | Files | Lines  | Role                                                        |
| ------------------------------- | ----: | -----: | ----------------------------------------------------------- |
| `apps/app/src/flow-agent/`      |    94 | 30,519 | Headless tick loop, action runtime, UCAN wiring, tracing     |
| `apps/app/src/plugins/`         |    42 | 18,381 | `flow-agent`, `flow-workflows`, `oracle-delegation`          |
| `apps/app/src/helpers/`         |    11 |  7,231 | Headless `@ixo/editor/core` + Matrix CRDT plumbing           |
| `packages/flow-work/`           |    14 |  4,717 | Helper-oracle work contract (own workspace, own lockfile)    |
| `apps/flow-dashboard/`          |    21 |  1,904 | React operator dashboard                                     |

66 test files, 6 e2e specs, 6 CI workflows. **Zero `TODO`/`FIXME`/`HACK` markers** in the entire
tree — unusual discipline. Type assertions are concentrated in tests; production has a handful
(`receipt-listener.ts` 5, `flow-agent.tokens.ts` 5, `flow-status.service.ts` 4).

### 1.2 What is genuinely strong

Worth stating plainly, because the findings below are about a system that is already well past
prototype:

- **A clean ownership boundary, written down and honoured.** `@ixo/editor/core` owns Flow Agent
  semantics (planning, UCAN policy, leases, validation, state transitions); this host orchestrates
  Matrix, discovery, scheduling and tracing. `flow-agent/README.md` states "the host must never
  grow a parallel execution path", and the code does not.
- **Fail-closed UCAN signing.** `ucan-signing.ts` resolves an Ed25519 mnemonic from the oracle's
  Matrix account room, derives its `did:key`, and refuses to sign unless that key is a registered
  verification method on the issuer's on-chain DID document. Memoized, with failures explicitly
  *not* cached. Decryption errors are deliberately generic so key material can't echo.
- **Real observability, not logging.** Every tick — worker, HTTP, or CLI — opens a durable run with
  an ordered span waterfall (`FlowTraceRecorder` → SQLite → `/flow-agent/traces/*` → React
  dashboard → read-only MCP). Recording is wrapped so it can never throw into the tick path.
- **Honest degradation.** Registry falls back to memory when SQLite is unavailable; trace flush and
  learning capture are best-effort; the `agentHostAudit` array exists specifically so evidence is
  never silently dropped when the shared ledger shape rejects a write.
- **The human round trip is complete**, not stubbed: notify → structured request tile → correlated
  reply → LLM extraction re-validated against the editor registry → write → resume, with an e2e
  spec covering it.
- **Existing self-criticism.** `docs/flow-agent/production-gap-triage.md` is a rigorous, evidence-
  cited gap matrix. Several findings below extend it rather than discover it.

### 1.3 Findings

Severity: **S1** ships broken behaviour today · **S2** breaks under production load or failure ·
**S3** structural/maintainability · **S4** latent risk.

---

#### S1-A. The production system prompt commands five tools that do not exist

`apps/app/src/main.ts` ships a ~5 KB `customInstructions` block. It instructs the agent, in
hard-rule voice, to use:

| Tool named in the prompt   | Where it exists                                            |
| -------------------------- | ---------------------------------------------------------- |
| `start_flow_workflow`      | `main.ts` + `CHANGELOG.md` only                            |
| `get_flow_workflow_status` | `main.ts` + `CHANGELOG.md` only                            |
| `approve_flow_workflow`    | `main.ts` + `CHANGELOG.md` only                            |
| `get_flow_learnings`       | `main.ts`, `README.md`, a seed script — **no agent tool**  |
| `record_flow_learning`     | `main.ts`, `README.md` — **no agent tool**                 |

`flow-workflows.tools.ts` defines exactly four tools: `write_entities`,
`find_blueprints_for_purpose`, `generate_and_display_domain_card`, `restore_existing_preview`.

The damage is not just a dead reference. The prompt spends an entire section — *"Builder mode vs.
workflow runs — never swap the two"* — establishing a rule around `start_flow_workflow`, naming
three workflows (`flow_readiness_review`, `flow_build_repair`, `research_to_flow_blueprint`) that
exist nowhere in the code, and ending with *"if the user explicitly asks to run a readiness review
… use `start_flow_workflow` — never hand-build it with `create_template`."* A user who asks for a
readiness review is routed, by explicit instruction, into a dead end.

Likewise the *"Learn from past flows before you plan"* section is built entirely on
`get_flow_learnings`/`record_flow_learning`. The **store** exists and is populated
(`FlowLearningStore`, fed by `FlowTickService.captureLearnings` from `agent.memory` ledger events),
so real data is accumulating with no read path for the agent that is told to read it.

This is **systemic drift, not a one-off**: `docs/flow-agent/production-gap-triage.md` cites
`flow-workflows.tools.ts:summarizeFlowLearnings`, which no longer exists either. Tools were removed
and three separate surfaces — the prompt, the README, the triage doc — were left behind.

#### S1-B. CI does not run the tests

`.github/workflows/ci.yml` is the only PR gate. Its steps: install → **build → lint →
format:check**. There is no `pnpm test`. The root `package.json` has `test: turbo test`, the app
has `vitest run`, and there are 66 test files including six e2e specs covering the Ralph loop, the
human round trip, and the ten-oracle system — **none of which gate a pull request.**

The only workflow that runs tests is `ci-flow-work.yml`, scoped by path to `packages/flow-work/**`
(an isolated mini-workspace, deliberately excluded from the root). `node-ci-build.yml` runs on
*push to main/develop* — post-merge, and it delegates to a shared reusable workflow whose contents
should be verified before assuming it tests anything.

For a service whose correctness story rests on an e2e behaviour matrix, this is the single
highest-leverage gap in the repo.

---

#### S2-A. A timed-out tick wedges its room until process restart

`FlowAgentWorkerService.tickRoomWithTimeout` races the tick against a timeout, but the losing
promise is never cancelled — the code says so:

> `note: 'The room remains marked in-progress until the original tick promise settles'`

`activeRoomTicks.delete()` only runs in the tick's own `.finally()`. A tick hung inside Matrix sync
or a Y.Doc connect therefore holds its room in `activeRoomTicks` **forever**, and every subsequent
worker run logs "Skipping Flow Agent room tick already in progress" and moves on. That flow stops
advancing, silently, with no escalation — and `getLiveness()` reports `tickLoopRunning: true`, so
it looks healthy.

There is no `AbortSignal` threaded into `FlowTickService.tickRoom` → `withFlowDoc` → the editor
runtime, so the fix is not a one-liner.

#### S2-B. Serial ticking is the scaling ceiling

`runOnce()` iterates due rooms with `await` in a plain `for` loop. With the defaults —
`FLOW_AGENT_WORKER_INTERVAL_MS=60_000`, `FLOW_AGENT_WORKER_TICK_TIMEOUT_MS=120_000` — a single slow
room can consume two full intervals on its own. `runOnce` refuses to re-enter while running, so
overruns don't pile up; they turn into **skipped cycles**. Rooms are processed in registry order
every run, so a slow room at the head systematically delays the tail. There is no concurrency
limit, no fairness rotation, and no metric for "time since this room last actually ticked".

The registry's scheduling is sound in itself — `listEnabledFlowRooms` honours `nextTickAt`, with
exponential failure backoff (`interval * 2^consecutiveFailures`, capped) and a separate idle
backoff. The bottleneck is purely the serial drain.

#### S2-C. Two contradictory defaults for the rollout safety gate

- `flow-room-discovery.service.ts`: `isRoomOptInRequired()` returns
  `env.FLOW_AGENT_REQUIRE_ROOM_OPT_IN !== 'false'` → **defaults to required (fail closed)**, which
  matches `flow-agent/README.md`.
- `plugins/flow-agent/flow-agent.plugin.ts` `configSchema`:
  `FLOW_AGENT_REQUIRE_ROOM_OPT_IN: z.string().default('false')` → **declares the opposite**.

The effective behaviour is the safe one, because the gate reads `process.env` directly and Zod
defaults land in the validated config object without writing back to `process.env`. So the plugin's
declared default is inert *and* wrong — it documents the unsafe posture for a controlled-rollout
gate. Anyone who later routes the gate through `rtCtx.config` (the correct thing to do) silently
flips the agent to acting on every invited flow room.

This is a specific instance of a general pattern: **37 distinct env vars are read via raw
`process.env` at call sites**, and seven of them (`FLOW_AGENT_CLI_TIMEOUT_MS`,
`FLOW_AGENT_DASHBOARD_PORT`, `FLOW_AGENT_IDLE_TICK_INTERVAL_MS`, `FLOW_AGENT_IDLE_TICK_THRESHOLD`,
`FLOW_AGENT_TIMELINE_PRUNE_MIN_EVENTS`, `FLOW_AGENT_TRACE_RETENTION_DAYS`,
`FLOW_AGENT_WATCH_UDID_TIMEOUT_SECONDS`) appear in **no** schema at all, so they bypass validation
entirely.

#### S2-D. The deployment config does not match the workload

`fly.toml` still reads `app = 'qiforge'` — inherited from the parent repo, not renamed for
flow-manager (whose deployment targets are `flow-manager.{testnet,mainnet}.ixo.earth` per
`oracle.config.json`). Beyond the name:

- **Health check hits `/`.** `FlowAgentWorkerService.getLiveness()` exists — `tickLoopRunning`,
  `runInProgress`, `activeRoomTickCount` — and is not wired to any platform probe. The one failure
  mode that matters (worker wedged, HTTP fine) is invisible to Fly.
- **`auto_stop_machines = 'stop'`** on a service whose primary job is a background timer. Held up
  only by `min_machines_running = 1`; there is no guard that the tick loop keeps running.
- **1 GB / 1 shared CPU**, against a documented OOM history: `pruneMatrixTimelines` exists because
  "the singleton client accumulates every synced event forever and the process OOMs after a few
  days of ticks", and the prune had to be moved to fire after *every* room tick because a run over
  many rooms "can outlive the heap headroom". That is memory pressure being managed by workaround
  at the current room count, on the smallest VM tier.
- **Four SQLite databases** (`flow-agent-registry.db`, `flow-agent-traces.db`, `flow-learnings.db`,
  plus the runtime checkpointer) on one 1 GB volume, with retention implemented for traces only.
- `Dockerfile` `EXPOSE 3000` vs `internal_port = 4000` — harmless, but symptomatic.

Combined with the documented single-host assumption and `kill_timeout = '2m0s'`, a rolling deploy
briefly runs **two hosts ticking the same rooms** with no cross-instance fencing. Editor-core leases
fence individual command commits, so this is duplicated planning and raced discovery rather than
double execution — but it is unmodelled. `docs/flow-agent-ha-fencing.md` exists; the mechanism does
not.

---

#### S3-A. Two god-files, one of them misnamed

- **`flow-agent/flow-agent.tokens.ts` — 3,998 lines, 5 exports.** The name says "DI tokens"; the
  contents are the entire live execution engine: `EditorFlowAgentRuntimeRunner`, the host audit
  surface, missing-input replacement, overdue escalation, retry-memory classification, watch-UDID
  reconciliation, stale-config reclassification, evaluator suggestion, delegated diagnosis. Roughly
  70 top-level helpers. Nothing about the filename tells a reader that the most consequential code
  in the service lives here.
- **`plugins/oracle-delegation/receipt-listener.ts` — 2,497 lines, ~40 top-level functions.**
  Pending-invocation registry, retry scheduling, three separate Matrix receipt sources (state,
  REST history, timeline), receipt matching, orphan repair, work-item handling, diagnosis
  recording — plus `readXeroPaymentBlockConfig`, a vendor-specific reader embedded in what should be
  a generic receipt path.

Both are the highest-churn, highest-risk files in the service and the hardest to review.

#### S3-B. Production authorization data lives in a `.fixtures` file

`flow-agent/ucan-guardrail.fixtures.ts` exports `AGENT_COMMAND_TO_CAPABILITY` and
`BLOCK_ACTION_TO_CAPABILITY` — the command→capability and action→capability maps that gate planning
and execution — alongside `UCAN_GUARDRAIL_FIXTURES`, a generated test matrix. `flow-tick.service.ts`
and `flow-agent.tokens.ts` both import the production maps from it. A reader pruning "test
fixtures" from the production bundle would delete the authorization model.

#### S3-C. Documentation drifts in both directions

- `CLAUDE.md` describes `apps/app/src/graph/` agents, `MainAgentGraphState`, and
  `graph/nodes/tools-node/` — then corrects itself mid-document to say that structure "does not
  exist here". Both halves are still present.
- `docs/flow-agent/production-gap-triage.md` (2026-07-06) cites `summarizeFlowLearnings`, since
  removed, and reports room opt-in gating as "Missing: explicit in-room or owner-authored opt-in
  metadata" — which has since shipped as the `ixo.flow.agent.config` state event.

The triage doc is good enough to be worth keeping accurate; right now it is stale in both
directions, which is worse than either.

---

#### S4-A. Signing-key encryption is weaker than the system it protects

`ucan-signing.ts:decryptSigningMnemonic` uses AES-256-CBC with
`key = Buffer.from(pin.padEnd(32))` — the PIN, space-padded. No KDF, no salt, no authentication tag.
A short numeric PIN gives an effective key space of a few digits; CBC without a MAC is malleable.

This mirrors `setupClaimSigningMnemonics` in `@ixo/oracles-chain-client`, so it is an **ecosystem
format constraint, not a local bug** — flow-manager cannot change it unilaterally. But it is the
wrapping around the key that signs every UCAN this oracle issues, and it deserves a scheduled
migration (Argon2id/scrypt + AES-GCM, versioned payload) at the ecosystem level.

Also: `pin.padEnd(32)` throws opaquely if a PIN exceeds 32 characters, and the generic catch
reports it as "wrong MATRIX_VALUE_PIN".

#### S4-B. The signer registration check has two fail-open paths

`createFlowManagerUcanContext` calls `assertUcanSignerRegistered` **only when
`material.source === 'matrix_account_room'`** — the `UCAN_SIGNING_MNEMONIC` override path skips it
entirely. And `assertUcanSignerRegistered` returns early when `BLOCKSYNC_GRAPHQL_URL` is unset.

`probeUcanSigner` covers both at startup, so a misconfiguration is *reported* — but at runtime,
signing proceeds with an unverified key and the failure surfaces downstream as
`[INVALID_SIGNATURE]` at a receiving oracle rather than as a local refusal.

#### S4-C. `FLOW_DASHBOARD_AUTH_DISABLED=true` has no production guard

`FlowDashboardAuthGuard.canActivate` returns `true` unconditionally when the env var is set. The
guarded routes are also excluded from the runtime auth middleware
(`FlowAgentPlugin.getAuthExcludedRoutes`), so this guard is the *sole* authority over
`/flow-agent/status`, `/flow-agent/traces/*` and the trace SSE stream. One env var away from a
public flow-trace API. There is no `NODE_ENV`/`NETWORK` check on the escape hatch.

Adjacent, minor: `parseAllowlist` logs the raw `FLOW_DASHBOARD_OPERATORS` value on every parse.
The comment correctly notes DIDs are public — but it is unconditional diagnostic logging of a
security-relevant config value.

Positive contrast worth noting: `FlowHistoryMcpAuthService.verify` does it right — SHA-256 digest
plus `timingSafeEqual`, returning only a non-secret fingerprint, with `min(32)` enforced on the
token.

#### S4-D. Carried forward from the team's own triage (still open)

Action input contracts are hand-maintained (`ACTION_INPUT_CONTRACTS` + an `editor-action-map`
tripwire) pending editor-side input schemas; `stale_config` is not classified as a distinct blocker
cause; live execution still excludes `archive_flow`, `propose_config_change`,
`validate_external_state`; the learning store has no retention or export (traces have both).

---

## Part 2 — Aligning with flow creation

The recipe lifecycle (`specs/flow-recipe-lifecycle-design.md`) has twelve phases. **Flow Manager is
the natural host for all of them** — it already wires `FlowsPlugin` with
`manifestOverrides: { flows: { visibility: 'always' } }`, and it owns the runtime that executes
what gets built. This settles the open topology question from the earlier audit: option (1) — Flow
Manager is the orchestrator, the flows plugin is its toolbelt, and no session-transfer primitive is
needed.

The encouraging finding: **more of the lifecycle already exists here than in the runtime repo.**

| Phase                              | What this repo already has                                                                                     | Gap                                                                        |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 0/12 Recall + remember             | `FlowLearningStore` (sanitised, deduped, grouped by `source_template_id`), fed automatically from `agent.memory` | No agent tool reads or writes it (S1-A); it is not memory-engine            |
| 1 Find a recipe                    | `find_blueprints_for_purpose` + `searchBlueprints`, publishing into the entity-list block                       | Hard-codes `protocol/dao`; needs `protocol/flow`; no search of own spaces   |
| 2 Fork with provenance             | `source_template_id` is already read off `root` and used to group learnings                                     | No fork tool; `cloneFromProtocol` is portal-side and unexposed              |
| 3 Compose                          | `FlowsPlugin` (25 tools) + `getMissingActionInputs` as the single source of truth for requirements              | —                                                                          |
| 4 Derive capabilities              | **`editor-action-map.ts` → `BLOCK_ACTION_TO_CAPABILITY`** already maps every action to its `can`                | Not exposed as a builder tool; no lint; no signing hand-off                 |
| 5 Context page                     | The prompt already mandates narrative around blocks, with a read-first rule                                     | `update_page` still replaces the whole page — prompt-enforced, not tool-enforced |
| 6 Review loop                      | Pre-build confirm gate in the operating guide                                                                   | No post-build accept gate, nothing records acceptance                       |
| 7 Staff with agents                | `discoverCapableOracles` (indexer `cap:` search + chain-verified operator identity + claim-schema constraints)  | Internal to flow-work contracting; not a builder tool                       |
| 8 Save                             | `personalSpace` routing already works                                                                           | No portable recipe manifest, no content-addressed store                     |
| 9 Publish as `protocol/flow`       | `generate_and_display_domain_card` + `qi/domain.card-preview` → `qi/domain.sign` with linked resources          | No recipe-typed publish path; entity-type string unconfirmed               |
| 10 Topic                           | —                                                                                                                | No topics integration                                                      |
| 11 Run                             | **The whole tick loop.** `ixo.flow.agent.config` opt-in is already the per-flow "start the runtime" switch      | Nothing connects "template accepted" → "run instantiated + opted in"        |

**Phase 4 is the standout.** The pure function I proposed building — derive a flow's required
capability set from its steps — is already half-written here as `EDITOR_ACTION_CAPABILITY_MAP`,
because the tick loop needs exactly that mapping to enforce UCAN policy per block. Builder-side
capability derivation and runtime-side capability enforcement should read **one** map. Building the
builder tool against `editor-action-map.ts` makes the permission summary shown to the user
provably the same authority the runtime will later demand.

**Phase 11 is the second.** `ixo.flow.agent.config { enabled: boolean }` already exists as a
per-room Matrix state event that the Portal writes and discovery mirrors onto the registry. "Start
a flow run now" is, mechanically, *instantiate the template + write that event*. The runtime half
is done.

**The learning loop is the third.** `captureLearnings` is already harvesting block-level lessons
into a sanitised store, grouped by source template. That is precisely the Phase 0 recall substrate —
it just has no reader. Restoring `get_flow_learnings` is a small change that closes a loop already
producing data.

### Alignment work, in dependency order

1. **Resolve S1-A first** — decide, per phantom tool, restore-or-remove. `get_flow_learnings` /
   `record_flow_learning` should be **restored** (the store exists and is populated, and they are
   Phase 0/12). `start_flow_workflow` and friends should be **removed from the prompt** unless the
   three named workflows are actually being rebuilt. Nothing else in this plan is trustworthy while
   the prompt describes a fictional toolset.
2. **`protocol/flow` in `blueprint-lookup.ts`** — after confirming the on-chain string, and fixing
   the `protocol/dao` vs `dao/protocol` contradiction between `blueprint-lookup.ts` and the
   domain-indexer tool description. Note it filters client-side, so a wrong string returns empty
   rather than erroring.
3. **`describe_required_capabilities` + lint**, built on `editor-action-map.ts`, shared with the
   runtime guardrail.
4. **`find_capable_agents`** — promote `discoverCapableOracles` from internal function to tool.
5. **Recipe manifest + `export_recipe`/`instantiate_recipe`**, then fork-with-provenance
   (`source_template_id` is already the provenance key the learning store groups on).
6. **Publish path**: recipe → domain card → `qi/domain.sign` with the recipe as linked resource.
7. **Run hand-off**: instantiate + write `ixo.flow.agent.config`, as one gated user action.
8. **Lifecycle state + gate tools** (from the design doc) — and note this repo already has the
   right precedent in `FlowRegistryService`: durable SQLite state that survives restarts.

---

## Part 3 — Production hardening

### P0 — Trust the system again (days)

- **Reconcile prompt ↔ tools ↔ docs** (S1-A). Then add the tripwire that prevents recurrence: a
  test that extracts every backtick-quoted `snake_case` tool name from `main.ts`'s
  `customInstructions` and asserts each resolves to a registered tool. This one test would have
  caught both drift events.
- **Run the tests in CI** (S1-B). Add `pnpm test` to `ci.yml`; decide explicitly whether the e2e
  specs run per-PR or nightly, and make `test:e2e` a scheduled job if per-PR is too slow.
- **Fix the opt-in default contradiction** (S2-C) and route the gate through validated config
  rather than raw `process.env`.
- **Wire `getLiveness()` to a real health endpoint** and point the Fly check at it, with
  `activeRoomTickCount` and time-since-last-successful-tick as failure signals (S2-D).
- **Rename `fly.toml`'s app** and reconcile `EXPOSE`/`internal_port`.

### P1 — Survive failure (weeks)

- **Cancellable ticks** (S2-A): thread an `AbortSignal` from `tickRoomWithTimeout` through
  `FlowTickService.tickRoom` → `withFlowDoc`, and release `activeRoomTicks` on abort. Until then, a
  stopgap: evict entries older than 2× the tick timeout and record an `agent.escalation`.
- **Bounded-concurrency, fair tick drain** (S2-B): a small worker pool over due rooms, ordered by
  staleness, with a per-room "last successful tick" metric and an alert when it exceeds N intervals.
- **Multi-host fencing** (S2-D): implement `docs/flow-agent-ha-fencing.md`. A per-room lease in the
  registry (or a Matrix state event) with owner + expiry is enough to make rolling deploys and a
  second replica safe. This is the prerequisite for HA — today the answer to "can we run two?" is
  "no", which is also the answer to "can we deploy without a gap?".
- **Memory budget** (S2-D): make timeline pruning a policy with a measured ceiling rather than a
  best-effort call after every tick; raise the VM tier; add heap metrics to the tick trace
  (`process.memoryUsage()` is already logged per run — promote it to a trace field and alert on it).
- **Retention everywhere**: learnings and the registry need what traces already have.

### P2 — Structure (weeks, parallelisable)

- **Split `flow-agent.tokens.ts`** into `runtime-runner`, `host-audit`, `missing-input`,
  `escalation`, `retry-memory`, `watch-udid`, `stale-config` — and leave only the DI tokens behind
  the name. This is the precondition for anyone other than its author reviewing changes to the
  execution path.
- **Split `receipt-listener.ts`** and lift `readXeroPaymentBlockConfig` out of it into the Xero work
  module where the rest of that vendor's code already lives.
- **Move the capability maps out of `ucan-guardrail.fixtures.ts`** into `ucan-guardrail.ts`, leaving
  only the generated matrix in the fixtures file — then have the builder-side Phase 4 tool import
  the same map.
- **Centralise env**: one schema, one accessor, no raw `process.env` in services. Start with the
  seven unvalidated vars.
- **Refresh the triage doc** as part of the same PR that changes what it describes.

### P3 — Security (scheduled, some cross-repo)

- **Guard the auth escape hatch** (S4-C): refuse `FLOW_DASHBOARD_AUTH_DISABLED=true` unless
  `NODE_ENV !== 'production'`, and log loudly when it is honoured.
- **Close the signer fail-open paths** (S4-B): verify registration on the env-override path too, and
  treat a missing `BLOCKSYNC_GRAPHQL_URL` as a startup failure in deployed environments rather than
  a silent skip.
- **Open the crypto migration** (S4-A) with the `@ixo/oracles-chain-client` owners: versioned
  payload, real KDF, authenticated mode. Cross-repo, scheduled, not urgent — but it is the wrapper
  around the oracle's signing identity.
- **Rate-limit** the auth-excluded routes (`/flow-agent/auth`, `/traces/*`, `/mcp/flow-history`);
  they bypass the runtime middleware, so they need their own limits.

### P4 — Complete the runtime story

Finish the live-execution allowlist (`archive_flow`, `propose_config_change`,
`validate_external_state`), classify `stale_config` as a distinct blocker cause, add trace export
and replay, and give the learning store the same retention/export surface traces already have —
all four are already scoped in the team's own triage matrix.

### Sequencing note

P0 is small and mostly mechanical, and everything else is easier to trust once it lands — a green
test gate plus a prompt that matches reality is the foundation the alignment work in Part 2 sits on.
P1 and P2 can run in parallel: P1 is behavioural and needs care around the editor-core boundary; P2
is mechanical splitting with tests as the safety net (which requires P0-B first).

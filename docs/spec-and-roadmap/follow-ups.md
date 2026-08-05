# Follow-ups

Open work the spec deferred or the implementation discovered. Tracked here so they don't get lost in the issue tracker churn.

## Active follow-ups

### Replace `NoopLogger` with a real logger

**Spec:** §6.1, §6.2 (Logger interface).
**Task file:** `specs/tasks/TASK-FOLLOWUP-logger.md`.
**Blocks:** stable 1.0.0 release.

Internal modules accept an optional `Logger` with a `NoopLogger` fallback. The noop default silently swallows real diagnostic output. Replace with a real logger (recommended: `pino ^9.x`) so production runs are never silent.

Acceptance:

- `NoopLogger` does not appear in any source file under `packages/oracle-runtime/src/`.
- Default boot output includes structured logs with `plugin`, `event`, and `level` fields.
- Plugin authors still call `ctx.logger.info(...)` — no plugin-facing change.
- `OracleApp` exposes the root logger for fork-side customisation.

See the task file for the full plan.

### Rebuild the tasks plugin

**Spec:** §16 (catalog), §22.11 (plugin conversion).
**Task file:** `specs/tasks/TASK-31-tasks-plugin.md` (deferred).

The original port attempt revealed the legacy TasksModule is fundamentally incompatible with the new plugin contracts:

- Uses module-level singletons (`getActiveTasksService`).
- Bypasses `ctx.matrix.*` (calls `MatrixManager.getInstance()` directly).
- Bypasses `ctx.llm.get(role)` (lifts a custom provider).
- Bypasses `ctx.config` (reads env directly).
- Runs workers as the oracle admin instead of threading per-user UCAN.
- Workers don't actually integrate with the memory plugin's tool surface (the soft-dep is a stub).

Reimplementation should:

1. Use `ctx.matrix` / `ctx.llm` / `ctx.ucan` / `ctx.config` throughout.
2. Re-enter the agent via the runtime's `MainAgentGraph` with a proper per-user `RuntimeContext`.
3. Wire memory soft-dep via `ctx.availablePlugins.has('memory')` plus actual memory tool calls.
4. Ship `TasksModule` via `getNestModules()`.

Pure-data files from the port (task-doc, task-page-template, task-meta, template-registry, scheduler types, the 3 lifted unit specs) are reusable; runtime-layer files must be rewritten.

Currently the `tasksPlugin` is a stub in `plugins/index.ts` that opts in on `REDIS_URL` but contributes nothing.

### Build the calls plugin

**Spec:** §16 (catalog).
**Task file:** `specs/tasks/TASK-18-calls-plugin.md` (deferred).

Has a `@Controller('calls')` in the legacy code. The `getNestModules()` API extension that landed later would technically unblock it. Deferred for now — revisit alongside the tasks rebuild.

Currently the `callsPlugin` is a stub.

### Re-wrap secret material still in the legacy at-rest format

**Spec:** `specs/sovereign-key-custody.md` §1.
**Blocks:** the claim that the oracle's signing mnemonic and secrets key are protected at rest.

`packages/oracles-chain-client/src/matrix-bot/secret-box.ts` now writes scrypt + AES-256-GCM under a `v2:` prefix, and still _reads_ the scheme it replaces (the PIN space-padded to 32 bytes used directly as an AES key, CBC, no authentication tag). That legacy read path is the whole exposure: existing deployments keep the old ciphertext until something re-wraps it, so the hardening protects new deployments only.

`rewrap()` exists and is tested but is not wired into any write path. Two secrets need it, and they are stored differently:

- **The signing mnemonic** (`setup-claim-signing-mnemonics.ts`) lives in a room **state** event, so a re-wrap is a PUT over the same key — idempotent and cheap.
- **The P-256 encryption key** (`setup-encryption-key.ts`) lives in a **timeline** event referenced by `eventId` from a key-index state event. Timeline events are immutable, so re-wrapping means sending a new event and repointing the index entry — closer to a key rotation than an in-place update, and it must stay consistent if it is interrupted between the two writes.

In both cases the trigger is the same: on a successful unwrap, check `isLegacyCiphertext` and upgrade if so. A write failure should be logged but non-fatal — a readable secret must not become an unusable one because Matrix was briefly unavailable.

Deploy order matters and is documented in the module: the reader ships before the writer. A runtime that predates `v2` cannot read what a `v2` CLI produces. Note the runtime only _reads_ the encryption key; the CLI (`oracles-cli setup-encryption-key`) writes it, so the migration needs a home on one side or the other rather than falling out of normal operation.

Acceptance:

- Both secrets in a live deployment carry the `v2:` prefix.
- The migration runs at most once per secret and is safe to interrupt.
- `decryptLegacy` can then be deleted, with a release note naming the minimum runtime version.

### Drop the git-hosted `jsonld` dependency

**Blocks:** installing in any environment without egress to `codeload.github.com`.

Two transitive packages — `@digitalcredentials/jsonld-signatures@10.1.0` and `@digitalcredentials/vc@7.0.0`, both pinned by `@veramo/credential-ld@7.0.0` — declare a bare `jsonld` dependency pointing at a git tarball on `codeload.github.com`. A network that does not allow that host cannot install this repo at all, and the failure is opaque: a 403 on a tarball fetch, from a package name that appears nowhere in our `package.json` files.

It is avoidable. Both packages dropped the git dependency in later versions in favour of the registry-published `@digitalcredentials/jsonld` — `jsonld-signatures` at 9.3.2+ (latest 12.0.1) and `vc` at 9.0.0+ (latest 10.0.2). `@veramo/credential-ld@7.0.0` already depends on registry `@digitalcredentials/jsonld@^6.0.0` for its own use, so the fork is a dependency we accept anyway; only these two stale pins reach for it over git.

The bump crosses `credential-ld`'s declared ranges (`^10.0.0` and `^7.0.0`), so it needs overrides and real verification of the credential-signing path — which currently has no test coverage in this repo. That is the work.

A narrower stopgap, if the goal is only to get an install through: override `jsonld` to `npm:@digitalcredentials/jsonld@9.0.0`. It resolves and the workspace builds and tests clean, but it swaps the JSON-LD processor under credential signing from 8.3.3-0 to 9.0.0 with nothing exercising that path, so it is a local unblock and not a fix.

Note this removes one of two git dependencies. `@veramo-community/lds-ecdsa-secp256k1-recovery2020` is unpublished — `@veramo/credential-ld` declares it as `github:uport-project/…` — so it can only be resolved over git, never from the registry. That one is upstream's to fix.

Acceptance: `grep codeload pnpm-lock.yaml` returns nothing; an install succeeds with only `registry.npmjs.org` and `github.com` reachable; credential issuance and verification are covered by a test that runs in CI.

### Warn at boot when the value PIN is too weak to rely on

**Spec:** `specs/sovereign-key-custody.md` §1.

A KDF raises the cost of guessing a short PIN; it does not make one strong. `isWeakPassword` and `MIN_RECOMMENDED_PASSWORD_LENGTH` are exported for exactly this, and nothing calls them yet. `MATRIX_VALUE_PIN` should be checked at boot and produce one prominent warning — not an error, since raising the floor on an existing deployment would lock it out of its own secrets.

Acceptance: a short `MATRIX_VALUE_PIN` produces a boot warning naming the variable and the recommended length; boot still succeeds.

### Finish the Phase-1 constitution wiring

**Spec:** `specs/sovereign-agency-harness.md` §28 (W1–W9).
**Blocks:** the Phase-1 acceptance criteria — "no tool executes without a recorded decision."

Landed: the domain.md subset schema and parser, the example oracle's `domain.md`, the pure `authorize()` evaluator with its time source, and the `PluginTool.effect` declaration seam (W1, W3, and the type half of W5).

Outstanding:

- **W2** — `DomainContextModule`, `rtCtx.domain`, and the boot-time profile/anchoring policy.
- **W5 remainder** — the `effectByToolName` map beside `visibilityByToolName` in `graph/main-agent.ts` (the tool wrapper erases everything but name/description/schema, so the gate must read a map rather than the LangChain tool), plus effect annotations on the bundled plugins' tools.
- **W4** — `ConstitutionGateMiddleware`, its coverage of all three sub-agent seams, and removal of the `AUTHORIZATION OVERRIDE` auto-retry in `graph/subagent-as-tool.ts` (it injects "you are fully authorized" on a refusal, which is precisely what the constitution forbids).
- **W6/W7** — hash-chained decision records and the human-review escalation path.
- **W9** — CI fixtures and the end-to-end negative test.

Everything landed so far is inert: nothing reads the evaluator yet, so the gate is not enforcing.

### Publish `@ixo/domain.md` and contribute `authorize()` upstream

**Spec:** `specs/sovereign-agency-harness.md` §28 W3, §29.

`packages/oracle-runtime/src/constitution/` holds an in-repo parser for the subset of domain.md `1.0.0-rc.3` this runtime needs, and an `authorize()` implementing that spec's §8 resolution algorithm. Both are deliberately isolated behind one directory so they can be swapped for the upstream package.

The evaluator belongs beside the spec and its golden fixtures, so every conforming runtime shares one implementation rather than each re-deriving default-deny semantics. Once `@ixo/domain.md` ships `parseDomain` + `lint` + `authorize`, this directory should shrink to a thin adapter.

Acceptance: `SUPPORTED_SPEC_VERSION` and the local schemas are gone; the runtime depends on the published package; the fixture corpus moves upstream.

### Resolve two review flags on UDID v1.0 before it finalizes

**Spec:** `specs/sovereign-agency-harness.md` §17.

Raised while assessing the UDID drafts against the harness's evidence pipeline:

1. **`res.trace` vs the no-chain-of-thought rule.** UDID makes a trace mandatory for automated agents and describes it as linking reasoning logs. domain.md's runtime contract prohibits requiring or storing private chain-of-thought. The trace should be specified as the typed-fact ledger, rubric scores and tool receipts — reproducible rationale — not raw reasoning.
2. **`res.patch` discipline.** A patch overwrites digital-twin properties. It should additionally be bound to domain.md's fact-scoped source-of-truth rules, so a determination can only update facts for which its collection is the competent source and can never overwrite canonical protocol or IID state.

Acceptance: both raised against ixoworld's UDID draft and either adopted or answered.

### Serve and consume `auth.md`

**Spec:** `specs/sovereign-agency-harness.md` §18.

The WorkOS agent-registration protocol solves credential _acquisition_ at the Web2 boundary — not custody, which stays with DID verification methods and the entity's room secrets. Two independent pieces of work:

- **Inbound (cheap, near-term).** The oracle is itself a service whose 401 currently says "Missing x-ucan-delegation header." Serving `auth.md` plus RFC 9728 protected-resource metadata from the runtime's HTTP surface — via the existing auth-excluded-routes mechanism — makes the oracle a self-describing front door, and is the wire-level companion to what `domain.md` already declares in `services.entries[].auth`.
- **Outbound (Phase 3/4).** An onboarding capability that lets the _harness_ — never the model — register the entity with an external service on a 401, and custody the returned scoped credentials in the entity's encrypted room secrets. Registration is an effect: standing credentials, implied terms, possible spend. It must be a rights-gated action class with the acquired credentials recorded in decision records and requested scopes bounded by constitutional ceilings.

### Session-key delegation tier for unattended signing

**Spec:** `specs/sovereign-key-custody.md` §5, §6.

The tiered-quorum recommendation splits signing by action class: routine actions clear with the runtime share plus a policy co-signer, value and authority actions additionally require a steward device. That leaves a real gap — genuinely unattended work that is neither routine nor small enough to ignore.

A session-key tier closes it: the steward pre-authorizes a bounded window (validity, action classes, cumulative value ceiling, allowed counterparties) in one signing round; the runtime then signs within that envelope without further human presence. The envelope is a capability, so it is attenuable and revocable, and its exhaustion is a hard stop rather than a warning.

Acceptance: an expired or exhausted session envelope fails closed; the envelope's terms appear in every decision record it authorizes; revoking it kills in-flight authority.

### Make permit encoding pluggable, keep the authority model single

**Spec:** `specs/sovereign-key-custody.md` §9.2, §9.5.

Comparing our capability model against x402 showed that an EIP-3009 `transferWithAuthorization` is structurally a capability token — one-shot, replay-protected, bounded by value, recipient, asset and time. It is the same shape as a caveated UCAN invocation in a different wire format.

The lesson for the capability kernel: a permit's _encoding_ should be pluggable — UCAN for our own services, EIP-3009 for x402 rails, Cosmos `authz` grants for chain transactions — while the authority model that decides whether to mint one stays single. Otherwise each new rail grows its own parallel authorization path, which is how ambient authority returns.

Acceptance: minting a permit for a new rail requires an encoder, not a second policy path; the constitution gate is unaware of which encoding a permitted action will use.

### Unify human review with threshold co-signature

**Spec:** `specs/sovereign-key-custody.md` §5; `specs/sovereign-agency-harness.md` §28 W7.

Two mechanisms designed separately turn out to be the same one. The constitution's `manual_review_required` verdict asks a human steward to approve an action; the threshold-signing scheme asks a steward device to contribute a signing round for value and authority actions. If the steward's approval _is_ their signing round, review stops being an out-of-band ceremony that produces a proof reference and becomes a cryptographic precondition: the action cannot execute without it, because the signature does not exist.

The same convergence applies one layer down — the constitution gate is the natural home for the policy co-signer share, which makes a constitutional permit a precondition of signing rather than only a structural check.

Worth designing before W7's approval transport hardens, because retrofitting is a protocol change rather than an implementation one.

## Open design decisions

These are documented in the spec (§23) as future choices:

### Embeddings vs TF-IDF for plugin search

The original spec mentioned a `find_capability` meta-tool with TF-IDF ranking over manifests. After implementation, `find_capability` collapsed into `load_capability` (which returns the full manifest on load), but the TF-IDF infrastructure remains in `manifest/`. Embeddings-based ranking is an explicit future opt-in.

### Per-thread vs per-user loadedPlugins

Currently `loadedPlugins` is per-thread (cleared on new thread). Per-user persistence would mean the agent doesn't have to re-discover for repeat users. Trade-off: per-thread keeps each conversation fresh; per-user reduces meta-tool calls.

### Tier-1 token budget enforcement

Currently the Tier-1 prompt block has no hard cap. A 50-plugin oracle marking everything `always` could blow the budget silently. Options: warn at boot if Tier-1 > X tokens; configurable hard cap via `createOracleApp({ tier1TokenBudget })`.

### Plugin `requiresRuntime` version field

No version compat checking in v1. A plugin authored against `@ixo/oracle-runtime ^1.0.0` could in principle be loaded into a `2.x` runtime with a breaking change. Adding a `requiresRuntime` field on the plugin would let the loader validate.

## Out of scope for v1

Listed for clarity — these are not follow-ups in flight; they're deliberately out of scope:

- **Versioning policy.** Stability tiers per export, codemods, structured changelog format. Deferred to a separate versioning ticket.
- **LLM determinism.** Recorded fixtures, plug-matrix property tests, contract auto-tests, coverage gates, cross-version CI. Heavy infrastructure that the basic `createTestRuntime` skips.
- **`qiforge inspect --json` schema.** A formal JSON schema for `inspect` output. Out of scope until consumers exist.
- **Hot-load / hot-unload plugins at runtime.** Plugins resolve at boot only. Dynamic loading via `load_capability` is per-thread tool exposure, not plugin install/uninstall.
- **Per-deploy log shipping.** Datadog/ELK/Loki integration is per-fork.

## Adding a new follow-up

Append a new `### Section` to "Active follow-ups". Include:

- A one-paragraph summary.
- The relevant spec section (if any).
- A task file path (if a task exists in `specs/tasks/`).
- What's blocked by this follow-up.
- Acceptance criteria, even if rough.

Don't put TODOs in source files. Track them here.

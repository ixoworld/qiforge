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

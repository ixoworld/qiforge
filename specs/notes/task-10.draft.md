# task-10 createMainAgent rewrite — notes

## What landed

- `packages/oracle-runtime/src/graph/main-agent.ts` (248 LOC) — the registry-driven replacement
- `packages/oracle-runtime/src/graph/main-agent-types.ts` (91 LOC) — interfaces split out to keep main-agent on target
- `packages/oracle-runtime/src/graph/prompt-composer.ts` (311 LOC) — Tier-1 + base template + per-request slots
- `packages/oracle-runtime/src/graph/sub-agent-fallback.ts` (123 LOC) — `Promise.allSettled` collector
- `packages/oracle-runtime/src/graph/wrap-plugin-tool.ts` (61 LOC) — bridges `(args, ctx)` → `(args, runConfig)`
- `packages/oracle-runtime/src/graph/state.ts` (108 LOC) — annotation state mirror, owned by the runtime now
- `packages/oracle-runtime/src/graph/main-agent.test.ts` (313 LOC) — 6 tests
- `packages/oracle-runtime/src/graph/index.ts` — barrel updated

apps/app's `main-agent.ts` is untouched (TASK-32 deletes it).

## Behaviour preservation map (vs the 1,052-line monolith)

| Original concern | Where it lives now |
|---|---|
| Sub-agent `Promise.allSettled` (lines 612-687) | `sub-agent-fallback.ts` — same semantics, plugin name in log |
| 4 always-on middlewares (line 960) | `main-agent.ts` direct imports from `./middlewares` |
| Token limiter (conditional) | dropped here — moves into `creditsPlugin` (TASK-29) |
| 11-variable `AI_ASSISTANT_PROMPT.format` | `prompt-composer.ts` — typed input, single `composePrompt({...})` |
| Tier-1 capability block | rendered by `renderTier1` from manifest registry |
| `oracle.config.json` identity overrides | replaced by `identity` + `state.userPreferences.agentName` override |
| Per-user SQLite checkpointer | injected via `hooks.checkpointerForUser` (apps/app supplies the actual factory) |
| Model override priority chain | `hooks.resolveModel` (default = `ambient.llm.get('main')`) |
| Conditional sub-agents (Editor / TaskManager / AGUI) | each plugin's own `getSubAgents(ctx)` returns `[]` when conditions aren't met (TASK-16+) |
| Degraded-services notice | `hooks.degradedServicesBlock` — appended by composePrompt when supplied |

## UCAN minting (sandbox / memory / composio)

Preserved as a CONCEPT, not as code in createMainAgent. The original lines 199-440 minted oracle→service UCAN invocations inline because the monolith owned every external integration. Under the plugin model:

- Memory minting → `memoryPlugin.getMiddlewares` (sets a per-request header on the memory MCP client).
- Sandbox minting → `sandboxPlugin.getTools` (tools call `ctx.ucan.mintInvocation` themselves).
- Composio minting → `composioPlugin.getTools` (same pattern).

`RuntimeContext.ucan.mintInvocation` exists already (`build-runtime.ts:139`). So the UCAN-only auth contract is preserved; the minting code just relocates into the plugins that use the resulting headers. The runtime knows nothing about sandbox/memory/composio specifically.

## Sandbox tool secret-wrapping

DEFERRED to `sandboxPlugin` (TASK-22). The original `wrappedSandboxTools` block (lines 738-803) is sandbox-MCP-specific behaviour: it lazily creates a second MCP client carrying `x-os-*` (oracle secrets) + `x-us-*` (user secrets) headers on first `sandbox_run`. Putting it in `createMainAgent` would couple the runtime to a specific MCP server's header convention.

The clean hook is already there: a sandbox plugin's `getTools(ctx)` returns the wrapped tool itself, using `ctx.secrets.getValues(...)` + `ctx.config.ORACLE_SECRETS` to populate the headers. No surface area in `createMainAgent` is reserved for this; the seam is `getTools(ctx)` itself.

## State schema in oracle-runtime

The original `MainAgentGraphState` lived in `apps/app/src/graph/state.ts` and depended on apps-internal types (`UserContextData`, `BrowserToolCallDto`, etc.). The runtime can't import from apps/app, so I copied the schema into `packages/oracle-runtime/src/graph/state.ts` and pulled the types from the runtime's own surface (`UserContextData` from `plugin-api/types.ts`, browser-tool/ag-action types declared inline).

apps/app's copy stays untouched until TASK-32 wires the app to use the runtime's schema.

## Hooks vs ambient

`AmbientServices` already covers config/identity/secrets/matrix/llm/emit/ucan/logger. What it doesn't cover are knobs that today live as injected service factories:

- `checkpointerForUser` — depends on `UserMatrixSqliteSyncService` which holds Matrix sync state
- `getRoomTitle` (page-context middleware dep)
- `safetyModel` — a separate `BaseChatModel`, not a role lookup
- prompt-block overrides (`operationalMode`, `editorSection`, `composioContext`, `userSecretsContext`, `degradedServicesBlock`)

These got grouped under `MainAgentHooks` so apps don't have to wedge platform-specifics into the AmbientServices bag. When a bundled plugin lands that owns a particular block (editor, composio, etc.), the hook becomes that plugin's `getMiddlewares`/`getTools` output instead of an app-level supply.

## Sub-agent default adapter

`sub-agent-fallback.ts:defaultToAgentSpec` projects a `PluginSubAgent` into the `AgentSpec` shape understood by `createSubagentAsTool`. Sub-agent-internal tool calls go through a no-op invoke for now — the bundled plugins that actually own those sub-agents (memory, portal, firecrawl, domain-indexer, agui, editor, task-manager) will pass their own `toAgentSpec` adaptor that wraps the inner tools properly. The adapter signature (`toAgentSpec?: (subAgent, buildCtx) => AgentSpec`) is the seam.

## What I deliberately did not do

- Did NOT touch `apps/app/src/graph/agents/main-agent.ts`. TASK-32 owns the deletion.
- Did NOT export `createMainAgent` from `src/index.ts`. Internal — consumed by `createOracleApp` (TASK-11). Available via `'./graph/index.js'`.
- Did NOT add a token-limiter middleware. Moves with `creditsPlugin` (TASK-29).
- Did NOT re-implement search.ts, tier1-renderer.ts, registries — used what's already there.

## Test coverage

6 new tests in `main-agent.test.ts`:

1. compiles with empty registries
2. meta-tools come first in tools list
3. middleware order: validation → retry → page-context → safety → plugin
4. throwing sub-agent doesn't crash the build (logs and skips)
5. on-demand plugin tools only bind when listed in `state.loadedPlugins`
6. Tier-1 capability block renders into the prompt for `visibility: 'always'`

Total in the package now: 251 (was 245 before this task).

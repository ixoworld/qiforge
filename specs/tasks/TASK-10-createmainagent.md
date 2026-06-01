# TASK-10: `createMainAgent` rewrite

**Phase:** 2 — Discovery & Composition
**Spec:** §13.1, §13.2, §13.3
**Effort:** 5 days
**Depends on:** TASK-07, TASK-08, TASK-09
**Blocks:** TASK-11

## Goal

Replace today's 1,052-line `apps/app/src/graph/agents/main-agent.ts` with a ~250-line registry-driven `createMainAgent` in the runtime package. Behavior parity: every existing concern (UCAN minting, secrets injection, MCP setup, sub-agent fallback via `Promise.allSettled`, prompt template, model selection, checkpointer wiring) preserved — but inlined arrays become registry collects.

## Deliverables

### Created

- `packages/oracle-runtime/src/graph/main-agent.ts` — the rewritten `createMainAgent` per §13.1. Target: ~250 lines.
- `packages/oracle-runtime/src/graph/prompt-composer.ts` — `composePrompt({...})` helper called by `createMainAgent`. Builds the system prompt from base template + Tier-1 block + existing context fields (oracle context, operational mode, user context, time context, user preferences, editor context, slack formatting, secrets, composio).
- `packages/oracle-runtime/src/graph/sub-agent-fallback.ts` — `collectSubAgentsWithFallback(registry, buildCtx, requestCtx, ambient)` per §13.2. Uses `Promise.allSettled`. Logs and skips on init failure (matches today's `main-agent.ts:621`).
- `packages/oracle-runtime/src/graph/wrap-plugin-tool.ts` — `wrapPluginTool(toolDef, ambient)` per §13.3. Bridges plugin tool handlers into LangChain's `(args, runConfig)` signature, building `RuntimeContext` per call.

### Modified

- `apps/app/src/graph/agents/main-agent.ts` — gut and replace with a re-export from `@ixo/oracle-runtime` (or delete entirely if nothing else imports it). The fork's app calls `createOracleApp` instead, which calls the runtime's `createMainAgent` internally.

## Acceptance

- [ ] `createMainAgent({ registries, identity, config, requestCtx, ambient, state, availablePlugins })` returns a compiled agent.
- [ ] Tools list includes: 4 meta-tools (TASK-08) + eager tools (`visibility: 'always'`) + dynamically-loaded tools (filtered by `state.loadedPlugins`) + sub-agent tools + silent tools.
- [ ] Middleware chain: 4 always-on (TASK-09) + plugin-contributed (in topo order from `MiddlewareRegistry`).
- [ ] Prompt includes: Tier-1 block + existing 11 prompt-template variables preserved (oracle context, operational mode, user context, time, user prefs, editor, slack formatting, secrets, composio context).
- [ ] Sub-agent fallback: a sub-agent whose builder throws does NOT crash the agent build; logs the failure.
- [ ] `state.loadedPlugins` filters which `'on-demand'` plugins' tools are bound.
- [ ] Per-request context: `runtime.context.user`, `runtime.context.session` resolved from existing per-request glue (UCAN, OpenID token, sessionId).
- [ ] LOC: target ~250 lines for `main-agent.ts`. Helpers in their own files don't count toward this. Be honest — if it's 300, that's fine; if it's 500, simplify.

## Out of scope

- `createOracleApp` (TASK-11).
- Bundled plugin conversions (Phase 5 — TASK-16…TASK-31).
- Anything that's NOT in the current `apps/app/src/graph/agents/main-agent.ts`. Behavior parity, not feature additions.

## Notes

- §13.1 has the full pseudocode skeleton. Follow it.
- Preserve UCAN minting for sandbox/memory/composio (lines 199-440 in today's main-agent.ts). These continue to live in the runtime package's main-agent or in a helper.
- Preserve secrets injection for sandbox tools (today: `wrappedSandboxTools`). Once `sandboxPlugin` lands (TASK-22), it owns that logic; until then, it stays in main-agent as a bridge.
- LangChain v1 supports state-update returns from tools — needed for `load_capability` to write to `state.loadedPlugins`.
- Watch out: today's main-agent reads `oracle.config.json` for identity overrides. That's now `identity` from `createOracleApp` config.

# TASK-27: Convert `memoryPlugin` (with `sharedState.userProfile`)

**Phase:** 5 — Bundled plugin conversion
**Spec:** §16.1, §16.2, §7.3
**Effort:** 2.5 days
**Depends on:** TASK-11, TASK-15
**Blocks:** TASK-32
**Parallel with:** other plugin conversion tasks

## Goal

Convert the Memory feature (memory sub-agent + userContext enrichment middleware + Memory Engine MCP) into a plugin. Owns the existing `userContext` state field — does NOT rename it. Exposes `userProfile` via `getSharedState()` for other plugins to read. `visibility: 'always'`.

## Deliverables

### Created

- `packages/oracle-runtime/src/plugins/memory/memory.plugin.ts` — class per §16.2:
  - Manifest: title "Memory", `visibility: 'always'`, category `'memory'`.
  - `configSchema`: `MEMORY_MCP_URL`, `MEMORY_ENGINE_URL`.
  - `getSubAgents(ctx)` returns the memory sub-agent with `MEMORY_AGENT_PROMPT` and `summarizationMiddleware`.
  - `getMiddlewares()` returns the memory enrichment middleware that populates `state.userContext` per request.
  - `getSharedState()` returns `{ userProfile: (state) => state.userContext }` so other plugins read user profile via `ctx.shared.userProfile` per §7.3.
- `packages/oracle-runtime/src/plugins/memory/index.ts`
- `packages/oracle-runtime/src/plugins/memory/memory.plugin.test.ts`

### Moved (`git mv`)

- `apps/app/src/graph/agents/memory-agent.ts` → `packages/oracle-runtime/src/plugins/memory/memory-agent.ts`
- Memory Engine MCP client setup (today around `apps/app/src/graph/agents/main-agent.ts:411-439`) — extract into the plugin.
- The memory enrichment middleware (today's userContext population logic).

### Modified

- The UCAN-minting for memory MCP (today: `memoryHeaders` in main-agent) becomes plugin-internal.

## Acceptance

- [ ] Plugin loads with `MEMORY_MCP_URL` and `MEMORY_ENGINE_URL` set.
- [ ] `call_memory_agent` tool appears in agent's tool list (eager).
- [ ] `state.userContext` is populated by the enrichment middleware on every request.
- [ ] `ctx.shared.userProfile` is `state.userContext` for plugins that import `softDependsOn: ['memory']`.
- [ ] No state-field rename (`userContext` stays).
- [ ] Test: portal plugin (TASK-26) reads `ctx.shared.userProfile` and gets the populated profile.

## Out of scope

- New memory features.
- Renaming `userContext` state field.

## Notes

- §7.3 has the shared-state pattern. Memory is THE example.
- §16.2 has the manifest skeleton.
- `softDependsOn: ['memory']` for plugins like tasks (§19.3) and portal that read user profile when memory is loaded.
- The memory enrichment middleware is the most-used middleware — runs on every request to populate userContext from the Memory Engine.

# TASK-08: Four meta-tools

**Phase:** 2 — Discovery & Composition
**Spec:** §10
**Effort:** 2 days
**Depends on:** TASK-07
**Blocks:** TASK-10

## Goal

Implement the four built-in tools the agent always has: `find_capability`, `load_capability`, `list_capabilities`, `list_capability_details`. These are registered by the runtime, not by any plugin.

## Deliverables

### Created

- `packages/oracle-runtime/src/meta-tools/find-capability.ts`:
  - Schema: `{ query: string, limit: number = 5 }`.
  - Calls `searchCapability(index, query, limit)` from TASK-07.
  - Returns `Array<{ name, score, summary, matchReason }>`.
- `packages/oracle-runtime/src/meta-tools/load-capability.ts`:
  - Schema: `{ name: string }`.
  - Side effect: appends `name` to `state.loadedPlugins` via state update return value (LangGraph state-update pattern).
  - Validates: rejects if `name` is `'silent'` or doesn't exist; returns `{ alreadyAvailable: true }` if already in `loadedPlugins` or marked `'always'`.
  - Returns `{ loaded: true, tools: Array<{ name, description }> }` listing the plugin's newly available tools.
- `packages/oracle-runtime/src/meta-tools/list-capabilities.ts`:
  - Schema: `{ includeOnDemand?: boolean = true, includeSilent?: boolean = false }`.
  - Returns `Array<{ name, summary, visibility, loaded, category, tags }>`.
- `packages/oracle-runtime/src/meta-tools/list-capability-details.ts`:
  - Schema: `{ name: string }`.
  - Returns the full `PluginManifest` plus `{ tools: Array<{ name, description, schemaSummary }> }`.
- Unit tests covering: success paths, missing plugin, already-loaded handling, silent-excluded behavior.

### Modified

- `packages/oracle-runtime/src/index.ts` — export `buildMetaTools(manifestRegistry, toolRegistry)` factory used by TASK-10's `createMainAgent`.

## Acceptance

- [ ] `find_capability({ query: 'remind me' })` ranks `tasksPlugin` first when memory + tasks + slack manifests are loaded.
- [ ] `load_capability({ name: 'composio' })` returns a state update appending `'composio'` to `loadedPlugins`.
- [ ] `load_capability({ name: 'composio' })` called twice returns `{ alreadyAvailable: true }` on the second call.
- [ ] `load_capability({ name: 'langfuse' })` (silent) throws an error directing the caller to `find_capability` first.
- [ ] `list_capabilities({ includeSilent: false })` excludes silent plugins.
- [ ] `list_capability_details({ name: 'climate' })` returns manifest + tool list.

## Out of scope

- Wiring the meta-tools into the agent — that's TASK-10's job.
- Health status reporting (no `system_status` tool in v3 — `healthCheck` was removed per spec).

## Notes

- §10 has the exact tool schemas. Follow them.
- `load_capability` returns a state update, not a plain value — LangChain tools support returning state-update objects via `Command` or similar; check existing graph code in `apps/app/src/graph/agents/main-agent.ts` for the pattern used today.
- The `tools` list returned by `load_capability` and `list_capability_details` is helpful to the agent — it tells the agent what tools are now usable.

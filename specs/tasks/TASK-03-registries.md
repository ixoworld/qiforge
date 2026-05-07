# TASK-03: Six registries

**Phase:** 1 — Foundation
**Spec:** §12, §13
**Effort:** 2.5 days
**Depends on:** TASK-01, TASK-02
**Blocks:** TASK-04, TASK-09, TASK-10

## Goal

Implement the six registries that collect plugin contributions at boot. Each registry has `register(plugin, contribution)`, `collect(buildCtx)`, and `assertNoCollisions()`.

## Deliverables

### Created

- `packages/oracle-runtime/src/registries/tool-registry.ts` — collects from `plugin.getTools(buildCtx)`. Flat namespace; collision = boot error per §13.1.
- `packages/oracle-runtime/src/registries/subagent-registry.ts` — collects from `plugin.getSubAgents(buildCtx)`. Each entry tagged with its plugin name (for §14.2 fallback).
- `packages/oracle-runtime/src/registries/middleware-registry.ts` — collects from `plugin.getMiddlewares(buildCtx)`. Order = topo sort.
- `packages/oracle-runtime/src/registries/manifest-registry.ts` — collects `plugin.manifest`. Wires §5.5 cross-tool-reference check by calling TASK-02's `validateExamplesAgainstTools` against the ToolRegistry's collected tool names.
- `packages/oracle-runtime/src/registries/config-schema-registry.ts` — collects `plugin.configSchema`. Merges via Zod `.extend()`. Collision = later wins, with warning per §13.1.
- `packages/oracle-runtime/src/registries/shared-state-registry.ts` — collects `plugin.getSharedState()`. Builds `SharedAccessors` shape. Key collision = boot error per §13.1.
- Unit tests per registry: register-collect round-trip, collision detection, ordering.

## Acceptance

- [ ] Each registry exports a class or factory with `register`, `collect`, `assertNoCollisions`.
- [ ] Tool name collision: registering two plugins both contributing `send_message` throws with both plugin names.
- [ ] Sub-agent name collision: same.
- [ ] Shared-state key collision: same.
- [ ] Config schema collision: warns, later definition wins (test the merged result includes the second definition).
- [ ] Manifest example references a tool that doesn't exist → returns a validation error with plugin name + missing tool name.
- [ ] All collect() calls accept a `PluginContext` and forward it to lazy contributor functions.

## Out of scope

- Topo sort (TASK-04 owns the order).
- Manifest validation rules (TASK-02 already covers them; this just wires the cross-reference check).
- The ambient services or RuntimeContext (TASK-05).

## Notes

- Convention: each registry keeps an internal `Map<pluginName, contribution[]>`.
- `collect(buildCtx)` returns the collected entries in registration order — the topo order is applied by the loader (TASK-04), not the registries.
- §13 lists every registry's purpose. Stay close to that table.

# TASK-37: Plugin state extension — typed, persistent, per-user

**Phase:** Framework v2 follow-up
**Effort:** ~1 day
**Depends on:** TASK-10 (createMainAgent), TASK-11 (createOracleApp), the per-user SQLite checkpointer
**Blocks:** any plugin that needs durable per-user state across turns (tasks plugin, reminders, multi-turn flows)

## Goal

Today, plugins have two options for state:
1. **`getSharedState`** — read-only projection on top of the graph state. Plugins can't write here; they only expose `(state, runCtx) => unknown` accessors.
2. **Process-local closures / `Map<sessionId, ...>`** — what the Weather plugin does. Doesn't survive restart, doesn't sync to Matrix, doesn't isolate per-user-thread automatically.

What's missing: a way for plugins to declare **typed graph-state fields** that get checkpointed + Matrix-synced per user via the runtime's existing infrastructure. LangGraph already does the hard work (per-user SQLite checkpointer, encrypted Matrix sync, Annotation reducers, replay/branch) — plugins just can't reach it.

## What's wrong today

- Surfaced during Weather dogfooding: `lastWeatherQuery` lives in a process-local `Map` — fine for a demo, brittle for production (lost on restart, not per-user).
- The tasks plugin (TASK-31, deferred) hits this immediately: tracking a user's task list, due dates, status transitions across turns is exactly what graph state was designed for.
- Memory smuggles `userContext` via a middleware `stateSchema` — that's the documented escape hatch, but it's not obvious and isn't a clean public API.

## API

New optional hook on `OraclePlugin`:

```ts
import { Annotation } from '@langchain/langgraph';

abstract class OraclePlugin {
  // existing hooks ...

  /**
   * Typed graph-state fields this plugin contributes. Merged into the runtime's
   * `MainAgentGraphState` at boot so they participate in checkpointing,
   * Matrix-sync, and reducer composition automatically.
   *
   * Plugins read/write these fields:
   *   • Read: via `state` inside tool handlers, middlewares, sub-agents
   *   • Write: by returning `new Command({ update: { <field>: <value> } })`
   *     from a tool, or via middleware `before`/`after` returns
   *
   * Backwards compatible: plugins that omit this hook keep behaving as today.
   */
  stateExtensions?(): Record<string, ReturnType<typeof Annotation>>;
}
```

Each entry is a LangGraph `Annotation` with its own reducer (or the default last-write-wins). Plugin owns the shape.

## Implementation

1. **Declare the hook** in `packages/oracle-runtime/src/plugin-api/oracle-plugin.ts` + `types.ts` (re-export type).

2. **Compose at boot** — touch `packages/oracle-runtime/src/graph/state.ts`:
   - Today: `export const MainAgentGraphState = Annotation.Root({...fixed fields})`.
   - New: export a `composeMainAgentGraphState(plugins: OraclePlugin[])` function that calls each plugin's `stateExtensions()`, deep-merges with the runtime's base fields, and returns the composed Annotation root.
   - Keep the existing `MainAgentGraphState` export for backwards compatibility (used by tests that don't go through `createOracleApp`).

3. **Wire in `create-oracle-app.ts`**:
   - After `resolved.loaded` is computed, compose the state schema:
     ```ts
     const composedState = composeMainAgentGraphState(resolved.loaded);
     ```
   - Thread `composedState` through the bundle so `agent-builder.ts` uses it.

4. **`agent-builder.ts`** — the priorState pre-read already calls `checkpointer.getTuple()`; the resulting `channel_values` will simply have more fields. Validate it doesn't choke on plugin-extension fields the runtime doesn't know about (it shouldn't — `channel_values` is just `Record<string, unknown>`).

5. **`main-agent.ts`** — pass the composed state schema to `createAgent({ stateSchema: composedState, ... })`.

6. **Collision detection** — at boot, error if two plugins declare the same field name OR collide with a runtime-owned field. Reuse the existing collision-detection pattern from `tool-registry` / `subagent-registry`.

7. **Update Weather plugin** to demonstrate:
   - Declare `lastWeatherQuery` as a graph-state extension instead of a process-local Map.
   - Tools return `Command({ update: { lastWeatherQuery: {...} } })` to write.
   - `getSharedState` reads from `state.lastWeatherQuery` instead of the Map.
   - Drop the `private lastBySession: Map<...>` entirely.

## Tests

Add to `packages/oracle-runtime/src/graph/state.test.ts` (or create) and `packages/oracle-runtime/src/bootstrap/create-oracle-app.test.ts`:

- [ ] `composeMainAgentGraphState` merges plugin fields with runtime base fields.
- [ ] A plugin that doesn't implement `stateExtensions` doesn't break anything.
- [ ] Two plugins declaring the same field name throws a boot error naming both.
- [ ] A plugin declaring a name that collides with a runtime field (e.g. `messages`) throws.
- [ ] End-to-end: a plugin tool returning `Command({update:{pluginField:'X'}})` is reflected in the next turn's state.
- [ ] Plugin state survives a checkpointer round-trip (write → `getTuple` → restored state has the value).

## Acceptance

- [ ] `OraclePlugin.stateExtensions` exists, typed, documented.
- [ ] `composeMainAgentGraphState` merges runtime + plugin fields.
- [ ] Collision detection at boot.
- [ ] Weather plugin migrated off the process-local Map onto graph state.
- [ ] All new tests pass.
- [ ] No regression in existing tests.

## Out of scope

- Per-plugin migration / versioning of state shapes — first ship is a snapshot. Migration is a follow-up.
- Per-plugin checkpoint isolation — all plugins share one checkpoint per user. Each plugin owns its own keys; collision detection prevents stomping.
- Typed `ctx.shared.*` cross-plugin reads — separate task (gap #16 in the framework feedback list).

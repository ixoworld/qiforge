# Adding a state field

`MainAgentGraphState` is shared between the framework and every plugin. Adding a field is a runtime-level decision — it changes the contract every plugin sees.

This isn't normal plugin work. Most plugins should use the [shared state](../architecture/runtime-context.md) pattern instead, which doesn't require touching the schema.

Reach for a new state field only when:

- The value participates in the LangGraph reducer model (must be merged across turns or across nodes).
- It must persist across turns within a thread (the checkpointer saves it).
- No existing field can carry it.

The only field the plugin runtime added since the legacy app: `loadedPlugins`.

## Checklist

- [ ] Edit the graph state annotation file.
- [ ] Pick the reducer carefully — last-write-wins, set-union, append, etc.
- [ ] Pick a default that's safe (`undefined`, `[]`, `new Set()`).
- [ ] If the field is plugin-owned, make sure the public docs note who owns it.
- [ ] Confirm the checkpointer serialisation works for the field's type (primitive types and JSON-compatible objects are fine; `Set` and `Map` need conversion).
- [ ] Update `architecture/graph-and-state.md`.
- [ ] Update `ixo-docs/build-an-oracle/reference/state-schema.mdx`.
- [ ] Update `runtime-context/build-runtime.ts` if plugins need a typed view via `rtCtx.history.state.X`.
- [ ] Add tests.

## Reducer choices

```ts
// Last-write-wins
reducer: (current, update) => update ?? current

// Set-union (loadedPlugins)
reducer: (current, update) =>
  Array.from(new Set([...(current ?? []), ...(update ?? [])]))

// Append
reducer: (current, update) =>
  [...(current ?? []), ...(update ?? [])]

// Shallow merge (object)
reducer: (current, update) =>
  ({ ...(current ?? {}), ...(update ?? {}) })

// Deep merge
// Don't. Implement it as a primitive field of the deep shape, or use shared state instead.
```

If you can't write the reducer in 1-2 lines, the data probably doesn't belong in the graph state. Use [shared state](../../docs/architecture/runtime-context.md) or a plugin-internal store.

## Where the field can be read

- **Plugin tools / middlewares / sub-agents:** via `rtCtx.history.state.<key>` — typed as `unknown` unless you extend `ReadonlyState`.
- **Plugin shared-state accessors:** via the `state` argument: `(state, runCtx) => state.<key>`.
- **The agent's main loop:** automatically; the reducer applies on every node return.

To give plugins a typed read, extend `ReadonlyState` in `plugin-api/types.ts`:

```ts
export interface ReadonlyState {
  readonly messages: readonly BaseMessage[];
  readonly userContext?: UserContextData;
  readonly loadedPlugins?: ReadonlySet<string>;
  readonly myNewField?: MyType;       // ← add here
  readonly [key: string]: unknown;
}
```

If the field is plugin-internal (only one plugin reads/writes), don't pollute `ReadonlyState` — let the consumer cast inside the owning plugin only.

## Persistence

The checkpointer serialises the state to SQLite. Watch for:

- **Sets / Maps:** JSON doesn't round-trip them. Convert to arrays in the reducer, or store as a plain object.
- **Functions / class instances:** don't store them. Only data.
- **Large blobs:** the state is saved per turn. A 1MB field × 100 turns = 100MB on disk. Compress, summarise, or store outside the state.

## Tests

- Unit test the reducer with edge cases (`undefined`, `null`, empty array, partial update).
- Integration test: send a message that triggers the field's update, then a second message and confirm the field persists.

## House rule

If you're tempted to add a state field for cross-plugin coordination, stop and ask whether [shared state](../architecture/runtime-context.md) or a plugin-internal Map suffices. State fields are a public contract — every plugin sees them and may come to depend on them. Adding one is hard to undo.

## Read next

- [Graph and state](../architecture/graph-and-state.md) — current fields and reducers.
- [Adding a meta-tool](adding-a-meta-tool.md) — meta-tools often pair with new state fields.

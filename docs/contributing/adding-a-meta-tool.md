# Adding a meta-tool

Meta-tools are built-in tools the runtime registers on every agent, not authored by plugins. There are currently two: `list_capabilities` and `load_capability`. Adding a third is a runtime-level change.

Source: `packages/oracle-runtime/src/meta-tools/`.

## When a meta-tool is the right answer

Meta-tools belong to the framework. Use them when:

- The functionality is about the **plugin system itself** (discovery, loading, introspection).
- Every agent benefits from it regardless of plugin set.
- A plugin couldn't provide it (because the plugin needs to inspect the registry, not just its own state).

If the answer is "a single plugin would need this tool", that plugin should ship it itself. Meta-tools are an escape hatch, not a general extension point.

## Checklist

- [ ] Create `meta-tools/<your-tool>.ts` exporting `build<YourTool>Tool(...)`.
- [ ] Add the builder to `meta-tools/index.ts`'s `buildMetaTools` array.
- [ ] If the tool needs new registry access, plumb it through `BuildMetaToolsOptions`.
- [ ] If the tool mutates graph state, document the state field in `architecture/graph-and-state.md` and the public `state-schema.mdx`.
- [ ] If the tool emits a `ToolMessage` (like `load_capability` does), match `ctx.toolCallId` correctly.
- [ ] Update `architecture/meta-tools-and-discovery.md` with the new tool.
- [ ] Update `ixo-docs/build-an-oracle/concepts/meta-tools.mdx`.
- [ ] Add tests in `meta-tools/<your-tool>.test.ts`.

## Shape of a meta-tool

```ts
import { z } from 'zod';
import { tool } from '../plugin-api/tool-helper.js';
import type { PluginTool } from '../plugin-api/types.js';
import type { ManifestRegistry } from '../registries/manifest-registry.js';

const inputSchema = z.object({ /* ... */ });

export function buildYourMetaTool(
  manifestRegistry: ManifestRegistry,
): PluginTool {
  return tool(
    async (args, ctx) => {
      const parsed = inputSchema.parse(args);
      // ... access registries via the injected references
      return JSON.stringify(result);
    },
    {
      name: 'your_meta_tool',
      description: '...',
      schema: inputSchema,
    },
  );
}
```

Conventions:

- Name in snake_case (`your_meta_tool`), matching the existing two.
- Always JSON-stringify the return when it's an array or complex object. LangChain's `tool()` helper mis-handles raw array returns (the `[content, artifact]` heuristic can drop the content). The existing `list_capabilities` source has the comment explaining this.
- Throw with a clear actionable message on invalid input rather than returning an error object — meta-tools should be unambiguous to the agent.

## State mutation

If your meta-tool needs to mutate the graph state (like `load_capability` does), return a LangGraph `Command` with both `update` (the state delta) and `messages` (a `ToolMessage` matching `ctx.toolCallId`).

```ts
return new Command({
  update: { myNewField: [...] },
  messages: [
    new ToolMessage({
      tool_call_id: ctx.toolCallId!,
      content: JSON.stringify(result),
    }),
  ],
});
```

If `ctx.toolCallId` isn't set (direct/test invocation), don't emit the `ToolMessage` — return just the value or skip the `Command` entirely. See `load_capability.ts`'s comment on this branch for the exact pattern.

## Registration

`meta-tools/index.ts`:

```ts
export function buildMetaTools(opts: BuildMetaToolsOptions): PluginTool[] {
  return [
    buildLoadCapabilityTool(opts.manifestRegistry, opts.toolRegistry),
    buildListCapabilitiesTool(opts.manifestRegistry),
    buildYourMetaTool(opts.manifestRegistry),    // ← add here
  ];
}
```

`createMainAgent` calls `buildMetaTools(...)` once per agent build and concatenates the result ahead of plugin tools and sub-agents.

## House rules

- **Meta-tools are not configurable.** Don't add knobs unless the runtime fundamentally needs them. The agent gets every meta-tool unconditionally.
- **No plugin authorability.** Plugins must not register tools with names that look like meta-tools (`find_capability`, `list_capability_details`, etc.). The validator should reject collisions; if not, fix the validator first.
- **Schema stability.** Once a meta-tool ships, its input and output shape become a contract every model has learned. Breaking changes ripple through every agent.

## Read next

- [Meta-tools and discovery](../architecture/meta-tools-and-discovery.md) — current meta-tools in detail.
- [Adding a state field](adding-a-state-field.md) — if your meta-tool needs new state.

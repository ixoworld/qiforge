# Graph and state

The LangGraph state schema, the reducers, and how plugin contributions reach the running agent.

Source: `packages/oracle-runtime/src/graph/` (state.ts, agent-builder.ts, prompt-composer.ts, main-agent.ts, middlewares/).

## MainAgentGraphState

```ts
export const MainAgentGraphState = Annotation.Root({
  messages: MessagesAnnotation.spec.messages,
  config: Annotation<{ wsId?: string; did: string }>({ ... }),
  client: Annotation<'portal' | 'matrix' | 'slack'>({ ... }),
  editorRoomId: Annotation<string | undefined>({ ... }),
  spaceId: Annotation<string | undefined>({ ... }),
  currentEntityDid: Annotation<string | undefined>({ ... }),
  browserTools: Annotation<BrowserToolCallDto[] | undefined>({ ... }),
  agActions: Annotation<AgActionDto[] | undefined>({ ... }),
  userContext: Annotation<UserContextData>({ ... }),
  mcpUcanContext: Annotation<{ invocations: Record<string, string> } | undefined>({ ... }),
  userPreferences: Annotation<UserPreferences | undefined>({ ... }),
  loadedPlugins: Annotation<string[]>({
    reducer: (current, update) =>
      Array.from(new Set([...(current ?? []), ...(update ?? [])])),
    default: () => [],
  }),
});
```

`loadedPlugins` is the only field the plugin runtime added; every other field is identical to the legacy `apps/app/src/graph/state.ts`. The reducer for `loadedPlugins` is a set-union — it never removes — and it's per-thread (cleared on new thread by the checkpointer).

## Reducers

The reducer per field determines how partial updates from agent nodes merge into the existing state:

- `messages` — LangGraph's `MessagesAnnotation` default: append + dedupe by ID.
- `loadedPlugins` — set union via the reducer above.
- Other fields — see source. Mostly last-write-wins or "merge if present".

When a middleware or tool returns a partial state update, LangGraph applies the per-field reducer before persisting.

## How plugin contributions reach the agent

Per-request, `MessagesController` calls into the agent build pipeline. The orchestrator is `createMainAgent` (in `graph/main-agent.ts`), which:

1. Builds a per-request `RuntimeContext` via `buildRuntimeContext(runConfig, ambient, state)`.
2. Builds a per-request `PluginContext` via `buildPluginContext({ config, identity, availablePlugins, logger, pluginName: '__main-agent__' })`.
3. Reads the cached boot snapshot for tools, sub-agents, middlewares from the registries.
4. Runs `getRequestTools(rtCtx)` and `getRequestSubAgents(rtCtx)` for every plugin to add request-time contributions.
5. Wraps each `PluginTool` and each `PluginSubAgent` via `wrapPluginTool` and `createSubagentAsTool` respectively, so they expose the standard LangChain `StructuredTool` shape.
6. Composes the system prompt via `composePrompt(...)` from base prompt + Tier-1 plugin block + identity + operational mode + memory enrichment + time context + user preferences + editor context + Slack formatting (when client is Slack) + secrets context + Composio context (if loaded).
7. Calls LangChain's `createAgent({ stateSchema: MainAgentGraphState, tools, middleware, prompt, model, checkpointer })`.

The returned agent is the compiled LangGraph runnable, which `MessagesController` then invokes / streams.

## Tool wrapping

```ts
function wrapPluginTool(toolDef: PluginToolDef, ambient: AmbientServices) {
  return tool(
    async (args, runConfig) => {
      const ctx = buildRuntimeContext(runConfig, ambient, ...);
      return await toolDef.handler(args, ctx);
    },
    {
      name: toolDef.name,
      description: prefixWithPluginTitle(toolDef.description, toolDef.pluginTitle),
      schema: toolDef.schema,
    },
  );
}
```

The wrapper synthesises a `RuntimeContext` from the LangGraph runtime + current state + ambient services. The plugin's handler never sees raw `runConfig` — it sees the typed context.

The tool's `description` is auto-prefixed with the plugin's `manifest.title` (e.g. `[Weather] Get the current weather…`). This prefix is added by the runtime, not the author.

## Sub-agent wrapping

`graph/createSubagentAsTool` wraps each `PluginSubAgent` into a tool. The wrapped tool:

- Takes a single `{ task: string }` arg (the parent agent's instruction).
- Internally builds a sub-graph via `createAgent` with the sub-agent's prompt, tools, optional middlewares.
- Runs the sub-graph and returns the final text.
- If `forwardTools` is truthy, forwards inner tool call events to the parent run so the UI renders them.
- Memory passthrough: the runtime injects non-destructive memory CRUD tools (search/save/read/delete) into every sub-agent's tool list automatically. `clear_memory` stays main-agent-only. No plugin API surfaces this — it's a runtime filter inside the agent builder.
- Parent-thread visibility: the inner run is a separate graph, so its tools can't see the invoking conversation (and `RuntimeContext.history` is deliberately empty inside tool handlers — the runtime doesn't pin the thread into tool closures). Before invoking the inner agent, the wrapper reads the parent graph's live messages (`getCurrentTaskInput`) and publishes them as an AsyncLocalStorage context variable scoped to the nested invocation. Inner tools that need the invoking thread — e.g. the evals plugin's execution-trace capture — read it via `graph/thread-context.ts` (`parentThreadMessages()` / `currentTaskMessages()`).

## Prompt composition

`composePrompt(...)` in `graph/prompt-composer.ts` builds the system prompt sections. Plugin-derived sections:

- **Tier-1 capability block** — alphabetical list of `always` plugins with their `manifest.summary`. Rendered by `ManifestRegistry.renderTier1(eagerPluginNames)`. ~80 tokens per plugin.
- **Loaded section** — listing of plugins the agent has `load_capability`'d so far in this thread.

Other sections (identity, operating mode, user context, time context, user preferences, editor context, Slack formatting, secrets context, Composio context) are framework-owned. Plugins shouldn't try to add free-form prompt content — their interface to the LLM is the manifest plus tool/sub-agent descriptions.

## Middlewares wired into the agent

Order is fixed:

1. `createToolValidationMiddleware()` — validates tool args against their Zod schemas before invoking.
2. `toolRetryMiddleware()` — LangChain built-in. One retry on tool validation failure.
3. `createPageContextMiddleware()` — injects active page context for editor flows.
4. `createSafetyGuardrailMiddleware()` — blocks output that violates the safety guardrails.
5. ...plugin-contributed middlewares from `MiddlewareRegistry.collect(buildCtx)` in topological order.

All four always-on middlewares ship in `graph/middlewares/`. They're not removable or reorderable.

## Read next

- [Plugin lifecycle](plugin-lifecycle.md) — when each hook fires.
- [Meta-tools and discovery](meta-tools-and-discovery.md) — how `loadedPlugins` is populated.
- [Runtime context](runtime-context.md) — what `buildRuntimeContext` synthesises.

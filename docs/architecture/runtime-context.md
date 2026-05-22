# Runtime context

How `RuntimeContext` is built per request, what gets injected, and what's lazily computed.

Source: `packages/oracle-runtime/src/runtime-context/`.

## Layout

```
runtime-context/
├── ambient.ts          # AmbientServices interface — the runtime's per-process service bag
├── build-plugin.ts     # buildPluginContext — boot-time
└── build-runtime.ts    # buildRuntimeContext — per request
```

## AmbientServices

`AmbientServices` is the per-process service bag built once at boot (phase 14) and reused on every request. It holds adapters for the Nest-managed services that `RuntimeContext` exposes:

```ts
interface AmbientServices {
  ucan: UcanAdapter;
  matrix: MatrixAdapter;
  secrets: SecretsAdapter;
  llm: LlmAdapter;
  emit: EmitFactory;
  logger: Logger;
  // ... etc
}
```

Adapters wrap Nest services with stable interfaces — `MatrixAdapter.postToRoom(roomId, content)` rather than the raw `matrix-js-sdk` client. This insulates plugins from churn inside the runtime.

`buildAmbientServices` is the factory; called once in `createOracleApp` after Nest's DI container exists.

## buildPluginContext

Boot-time (and per-request-build) context.

```ts
export function buildPluginContext({
  config,
  identity,
  availablePlugins,
  logger,
  pluginName,
}: BuildPluginContextInput): PluginContext {
  return {
    config,
    identity,
    availablePlugins,
    logger: logger.child?.({ plugin: pluginName }) ?? logger,
  };
}
```

The logger gets a `.child({ plugin: pluginName })` wrap when the underlying logger supports it (i.e. pino, NestJS Logger). Plugins see a logger pre-prefixed with their name.

## buildRuntimeContext

Per-request. Takes the LangGraph run config, the ambient services, and the current state; synthesises a `RuntimeContext`.

```ts
export function buildRuntimeContext(
  runConfig: RunConfig,
  ambient: AmbientServices,
  stateInput: RuntimeStateInput,
): RuntimeContext {
  // runConfig carries auth headers, user DID, session ID, etc.
  // ambient carries the per-process adapters.
  // stateInput is the current LangGraph state (typed as ReadonlyState).
  return {
    user: extractUser(runConfig),
    session: extractSession(runConfig),
    history: buildHistory(stateInput, runConfig),
    config: ambient.config,
    availablePlugins: ambient.availablePlugins,
    loadedPlugins: new Set(stateInput.loadedPlugins ?? []),
    secrets: bindSecrets(ambient.secrets, runConfig.session.roomId),
    matrix: ambient.matrix,
    ucan: bindUcan(ambient.ucan, runConfig.user.ucanDelegation),
    llm: ambient.llm,
    emit: ambient.emit.forSession(runConfig.session.id),
    logger: ambient.logger.child?.({ plugin: runConfig.pluginName }) ?? ambient.logger,
    abortSignal: runConfig.abortSignal,
    shared: buildSharedAccessors(stateInput, runConfig),
    toolCallId: runConfig.toolCallId,
  };
}
```

Most fields are direct references to ambient services. Three are computed per request:

- **`secrets`** — bound to the current `roomId` so plugin code doesn't have to pass it on every call.
- **`ucan`** — bound to the current user's delegation so `requireCapability` / `mintInvocation` operate on the right one.
- **`shared`** — built from `SharedStateRegistry` accessors, each invoked with `(stateInput, this)`.

## RunConfig

The input shape:

```ts
interface RunConfig {
  user: { did: string; matrixUserId: string; ucanDelegation: UcanDelegation; timezone?; currentTime? };
  session: { id: string; client: 'portal' | 'matrix' | 'slack'; wsId?; requestId; roomId? };
  abortSignal: AbortSignal;
  toolCallId?: string;
  pluginName?: string;       // for logger child binding
}
```

`MessagesController` builds the `RunConfig` from inbound HTTP headers and the resolved session, then hands it to the agent builder.

## What's eager vs lazy

| Field | When computed |
| --- | --- |
| `user`, `session` | Eager — extracted from runConfig on context build. |
| `history.messages`, `history.state` | Eager — reference into `stateInput`. |
| `history.userContext` | Eager — reference into `stateInput.userContext` (mutated by Memory plugin's middleware). |
| `secrets.getIndex`, `secrets.getValues` | Lazy — round-trip to Matrix on call. |
| `matrix.*` | Lazy — round-trip on call. |
| `ucan.mintInvocation` | Lazy — signs on call (caches per-target). |
| `ucan.resolveServiceDid` | Lazy — DID document fetch + cache. |
| `llm.get` | Lazy — model construction on call. |
| `emit.*` | Lazy — emits events on the per-session channel on call. |
| `shared.<key>` | Lazy — each access invokes the registered accessor with the latest state. |

The eager fields are cheap (object property access). The lazy ones do real work — plugins should be aware that calling them isn't free.

## Lifetime

A `RuntimeContext` lives for the duration of one LangGraph turn. It's created at agent-build time and torn down when the turn completes (or aborts). Don't capture references across turns — the inner services may have rebound (e.g. Matrix sync replayed events, the secrets cache invalidated).

For per-thread state that survives turns, use the graph state field (with a reducer) or the shared-state pattern (with a producer plugin keeping a Map keyed by session ID).

## Tool wrapping leverages this

When a plugin returns `getTools(ctx)` with a tool definition, the runtime wraps it:

```ts
return tool(
  async (args, runConfig) => {
    const ctx = buildRuntimeContext(runConfig, ambient, currentState);
    return await toolDef.handler(args, ctx);
  },
  { name, description, schema },
);
```

So the tool handler always sees a fresh `RuntimeContext` — even though the *tool definition* was cached at boot.

## Read next

- [Plugin lifecycle](plugin-lifecycle.md) — when contexts are built.
- [Modules](modules.md) — the Nest services ambient adapters wrap.
- [Graph and state](graph-and-state.md) — `stateInput` and the agent builder.

# TASK-05 implementation notes

## Event name mapping (verified against `@ixo/oracles-events` source)

| ctx.emit method            | Event name                   | Class                           |
| -------------------------- | ---------------------------- | ------------------------------- |
| `toolCall`                 | `tool_call`                  | `ToolCallEvent`                 |
| `actionCall`               | `action_call`                | `ActionCallEvent`               |
| `renderComponent`          | `render_component`           | `RenderComponentEvent`          |
| `reasoning`                | `reasoning`                  | `ReasoningEvent`                |
| `browserToolCall`          | `browser_tool_call`          | `BrowserToolCallEvent`          |
| `router`                   | `router.update`              | `RouterEvent`                   |
| `messageCacheInvalidation` | `message_cache_invalidation` | `MessageCacheInvalidationEvent` |

## Singleton wraps

- `secrets.getIndex()` → `SecretsService.getInstance().getSecretIndex(roomId)` returning `SecretIndexEntry[]`. The `SecretIndex` typed in `plugin-api/types.ts` is `Record<string, { key, version? }>`. We adapt by mapping the array to a record keyed by `name`. Stored entry as `{ key: eventId, version: undefined }` since `publicKeyId` rotation is the version concept.
- `secrets.getValues(keys)` → calls `getSecretIndex(roomId)` then `loadSecretValues(roomId, filteredIndex)`.
- `matrix.postToRoom(roomId, content)` → `MatrixManager.getInstance().sendMessage({ roomId, message: <stringified content> })`. Falls back to JSON.stringify for non-string content.
- `matrix.getRoomState(roomId)` → `getInstance().getClient()?.mxClient.getRoomState(roomId)` returning `RoomStateSnapshot { roomId, state }`.
- `matrix.getEventById(roomId, eventId)` → `getInstance().getEventById(roomId, eventId)` (returns `MatrixEvent` from matrix-bot-sdk; we adapt the shape to our local `MatrixEvent` interface).
- `llm.get(role, params?)` → wraps `getProviderChatModel`. Accepts the runtime's `ModelRole` plus extra strings via `(string & {})` to stay compatible with new roles.
- `ucan.requireCapability` / `hasCapability` — UCAN delegation comes from `RuntimeContext.user.ucanDelegation`. Ambient adapter just exposes a checker against capabilities array; `requireCapability` throws if absent. `mintInvocation` calls `UcanService.createServiceInvocation(serviceUrl, userDid, resource)` — the spec contract is `(target: { did, capability })` so we reuse `target.did` as the service identifier and `target.capability` as the resource.

## RuntimeContext source mapping

- `user`, `session` ← from `runConfig.context` (a typed bag passed by NestJS at graph invocation; LangGraph v1 puts this on `runtime.context` channel).
- `history.messages`, `history.userContext`, `history.state`, `loadedPlugins` ← from `state` (the Annotation snapshot).
- `availablePlugins` ← from ambient (boot-fixed, captured when ambient was constructed).
- `config`, `identity` ← from ambient.
- `secrets`, `matrix`, `llm`, `emit`, `ucan`, `logger` ← ambient (logger child-scoped per-plugin at PluginContext build time).
- `shared` ← `Object.freeze({})` for now; registry wiring lands later.
- `abortSignal` ← from `runConfig.signal` if present, else a fresh `AbortController().signal`.

## Logger

`ambient.logger.child({ plugin })` is documented in TASK-05 notes. The Logger interface defined in plugin-api/types.ts has no `child` method. Add an optional `child` method to the Logger interface — fall back to the same logger if `child` is undefined.

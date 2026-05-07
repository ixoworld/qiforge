# TASK-05: Plugin & Runtime contexts + ambient services + scoped emitter

**Phase:** 1 — Foundation
**Spec:** §6, §22.5
**Effort:** 4 days
**Depends on:** TASK-01
**Blocks:** TASK-06, TASK-09, TASK-10, TASK-12, TASK-13, TASK-14

## Goal

Synthesize `PluginContext` and `RuntimeContext` correctly. Build the ambient services bag (DI-backed adapters for secrets, matrix, llm, emit, logger, ucan) and the scoped event emitter that bridges today's `rootEventEmitter` to `ctx.emit`.

## Deliverables

### Created

- `packages/oracle-runtime/src/runtime-context/build-plugin.ts` — `buildPluginContext({ config, identity, availablePlugins, logger })` per §6.1.
- `packages/oracle-runtime/src/runtime-context/build-runtime.ts` — `buildRuntimeContext(runConfig, ambient, state)` per §6.2.
  - Reads `runtime.context` (LangGraph v1) for `user`, `session`.
  - Reads `state` for `history.messages`, `history.userContext`, `history.state`, `loadedPlugins`.
  - Wires ambient services into `ctx.secrets`, `ctx.matrix`, `ctx.llm`, `ctx.emit`, `ctx.ucan`, `ctx.logger`.
  - Resolves `ctx.shared` accessors via TASK-03's `SharedStateRegistry`.
- `packages/oracle-runtime/src/runtime-context/ambient.ts` — adapter interfaces wrapping today's singletons (`SecretsService`, `MatrixManager`, `UcanService`, `getProviderChatModel`, `rootEventEmitter`). Each adapter is constructor-injectable so tests can pass mocks.
- `packages/oracle-runtime/src/events/scoped-emitter.ts` — bridges `rootEventEmitter` to `ctx.emit.toolCall(...)` etc. per §6.3 mapping. Sets `sessionId` and `requestId` from RuntimeContext on every emit.
- Unit tests: build a context from a stub runConfig + ambient mock; verify each field maps from the right source; verify `ctx.emit.toolCall(...)` reaches the underlying emitter with `sessionId` set.

## Acceptance

- [ ] `buildPluginContext` returns an object with all 5 fields from §6.1.
- [ ] `buildRuntimeContext` returns an object with all fields from §6.2 including `loadedPlugins` (from state) and `availablePlugins` (boot-fixed).
- [ ] `ctx.secrets.getIndex()` calls today's `SecretsService.getInstance().getSecretIndex(roomId)` under the hood.
- [ ] `ctx.matrix.postToRoom(roomId, content)` calls the right `MatrixManager` method.
- [ ] `ctx.llm.get('main')` returns a `BaseChatModel`.
- [ ] `ctx.emit.toolCall({ ...payload })` results in a `rootEventEmitter.emit('tool_call', { sessionId, requestId, ...payload })`.
- [ ] `ctx.shared.<key>` is `undefined` if the plugin owning `<key>` isn't loaded (verify via TypeScript narrowing).
- [ ] All seven event types from `@ixo/events` are wired: `toolCall`, `actionCall`, `renderComponent`, `reasoning`, `browserToolCall`, `router`, `messageCacheInvalidation`.

## Out of scope

- The `tool()` helper or `OraclePlugin` class (TASK-06).
- Filling in the `loadedPlugins` reducer in state.ts (TASK-07).
- Anything to do with workers (out of scope per spec).

## Notes

- §6.3 has the full today→tomorrow mapping. Don't expose `UserMatrixSqliteSyncService`, `UserSkillsService`, or `UserPreferencesService` on RuntimeContext — those are consumed internally by their respective plugins.
- Logger: every plugin's logger is auto-prefixed with the plugin's name. Use `ambient.logger.child({ plugin: pluginName })`.
- The scoped emitter is the answer to v2 review's "ctx.emit wiring origin" question — explicit bridge from request session.

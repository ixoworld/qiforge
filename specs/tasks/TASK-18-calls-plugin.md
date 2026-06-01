# TASK-18: Convert `callsPlugin`

**Phase:** 5 — Bundled plugin conversion
**Spec:** §16.1
**Effort:** 2 days
**Depends on:** TASK-11, TASK-15
**Blocks:** TASK-32
**Parallel with:** other plugin conversion tasks

## Goal

Convert the calls feature (LiveKit call state + endpoints) into a plugin. `visibility: 'on-demand'`.

## Deliverables

### Created

- `packages/oracle-runtime/src/plugins/calls/calls.plugin.ts` — class `CallsPlugin extends OraclePlugin`. Manifest: title "Calls", category `'communication'`, `visibility: 'on-demand'`, `whenToUse` per agent triggers. `configSchema` for any LiveKit-related env vars.
- `packages/oracle-runtime/src/plugins/calls/index.ts`
- `packages/oracle-runtime/src/plugins/calls/calls.plugin.test.ts`

### Moved (`git mv`)

- `apps/app/src/calls/` → `packages/oracle-runtime/src/plugins/calls/`. Includes `CallsService`, `CallsController`, the existing `calls.service.spec.ts`.

### Modified

- The `CallsModule` becomes part of the plugin's NestJS module (the plugin's `getNestSubmodule()` if we add that helper, OR the runtime's `RuntimeAppModule` imports `CallsModule` when `features.calls !== false`).

## Acceptance

- [ ] Plugin loads when `features.calls !== false`.
- [ ] `CallsController` HTTP endpoints work as today.
- [ ] `CallsService.syncCall` and `listCalls` work — including the `markUserActive`/`markUserInactive` ref-counting around them.
- [ ] Test: invoking a calls tool through `createTestRuntime` returns expected results.
- [ ] Existing `calls.service.spec.ts` still passes after relocation.

## Out of scope

- New LiveKit features.
- Refactoring the controller pattern. The plugin owns a NestJS module today; that NestJS module continues to be used (since plugins themselves can't define controllers per §3 non-goal #7, but BUNDLED plugins can ship their own NestJS module that the runtime imports).

## Notes

- This is the only bundled plugin with HTTP endpoints (controllers). The pattern: bundled plugin ships a NestJS module; the runtime registers it conditionally based on `features.calls`. User plugins (developer-authored) can't ship controllers; if a developer wants HTTP endpoints, they pass a NestJS module to `createOracleApp({ nestModules })` per §15.
- The non-goal #7 about "plugins shouldn't define nest modules" applies to USER plugins; bundled plugins can ship NestJS infrastructure when needed.

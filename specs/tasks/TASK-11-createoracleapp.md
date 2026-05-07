# TASK-11: `createOracleApp` factory + `getNestApp`

**Phase:** 2 — Discovery & Composition
**Spec:** §15
**Effort:** 3 days
**Depends on:** TASK-04, TASK-10
**Blocks:** TASK-15, all plugin conversion tasks (TASK-16…TASK-31)

## Goal

Build the entry-point factory `createOracleApp` that bootstraps NestJS, runs the plugin loader, wires everything together, and returns an `OracleApp` with `getNestApp()`, `beforeListen`, `onPluginStatusChange`, `listen`. After this task, a fork's `main.ts` can be a 30-line file.

## Deliverables

### Created

- `packages/oracle-runtime/src/bootstrap/create-oracle-app.ts`:
  - `createOracleApp(opts: CreateOracleAppOptions)` per §15.1.
  - Phases per §14.1: resolve plugins → topo-sort → schema merge → env validation → manifest registration → registry population → NestJS bootstrap (with `userNestModules` spread into `AppModule.imports`) → background Matrix init → HTTP listen.
  - Returns `OracleApp` with: `getNestApp()`, `plugins.status()`, `beforeListen(fn)`, `onError(fn)`, `onPluginStatusChange(fn)`, `listen(port)`.
- `packages/oracle-runtime/src/bootstrap/runtime-app-module.ts`:
  - Dynamic `RuntimeAppModule` per §15.3. Imports core Tier-0 modules (TASK-12/13/14 will populate them) + bundled plugin NestJS modules (where plugins ship one) + `userNestModules` from config.
- `packages/oracle-runtime/src/bootstrap/graceful-shutdown.ts`:
  - SIGTERM handler that drains in-flight requests, calls plugin teardown (none in v3 — drop), uploads checkpoints, disconnects Matrix. Mirrors today's `apps/app/src/main.ts:206-295` SIGTERM logic exactly.

### Modified

- `packages/oracle-runtime/src/index.ts` — export `createOracleApp`, `OracleApp`, `CreateOracleAppOptions`, `BundledFeatureName`.

## Acceptance

- [ ] `createOracleApp({ identity, plugins: [], features: {} })` boots a minimal app with no plugins.
- [ ] `app.getNestApp()` returns the underlying `INestApplication`.
- [ ] `app.beforeListen(async (nestApp) => { ... })` is called before `app.listen()` resolves.
- [ ] `app.listen(3000)` starts the HTTP server.
- [ ] SIGTERM triggers checkpoint upload + Matrix disconnect (parity with `apps/app/src/main.ts:206-295`).
- [ ] Passing `nestModules: [MyModule]` results in `MyModule` being importable in the running Nest app (verify via `app.getNestApp().get(SomeServiceFromMyModule)`).
- [ ] Boot errors per §14.2 are emitted to stderr in pretty format.

## Out of scope

- `qiforge inspect` CLI (TASK-33).
- `/health/plugins` HTTP endpoint — out of scope for v3 spec (no health-check primitive). Add a basic `GET /plugins` that returns `app.plugins.status()` if straightforward; otherwise defer to TASK-33.
- Tier-0 module wiring: that's TASK-12/13/14. For now, leave imports empty and let those tasks fill them in.

## Notes

- §14.1 phase order: blocking phases 1-9, parallel phases 10-14, listen phase 15.
- Background Matrix init pattern from today's `main.ts:121` is preserved: `matrixManager.init().catch(...)` — fire and forget.
- The user's `nestModules: [...]` go into `RuntimeAppModule.imports` alongside core modules.
- `OracleApp` is the only thing the fork's `main.ts` interacts with. Keep its surface small per §15.1.

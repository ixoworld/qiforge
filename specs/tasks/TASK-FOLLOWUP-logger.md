# TASK-FOLLOWUP: Replace `NoopLogger` with a real logger

**Phase:** Follow-up (after main 34-task plan, before stable release)
**Spec:** §6.1, §6.2 (Logger interface)
**Effort:** 1 day
**Depends on:** all framework tasks landed (after TASK-11)
**Blocks:** stable 1.0.0 release

## Goal

Today, framework-internal modules (`plugin-loader.ts`, `schema-composer.ts`, registries, etc.) accept an optional `Logger` argument with a `NoopLogger` fallback. That fallback **silently swallows real diagnostic output** when nobody passes a logger. Replace the noop default with a real logger so production runs are never silent.

## What's wrong with `NoopLogger`

- Bugs that should print warnings disappear into `() => undefined`.
- Operators see "looks fine" boot output even when soft-deps are missing, plugins cascade off, or env collisions silently overwrite.
- Tests inject mocks anyway, so the noop default exists only to silence prod — exactly backwards.

## Options

1. **Console-backed default.** Tiny adapter wrapping `console.log/warn/error` to satisfy the `Logger` interface. Zero deps. Same shape NestJS uses.
2. **`@ixo/logger`** (already in workspace).
3. **`pino` (recommended)** — fast, structured JSON, child-logger support, the de facto Node standard. ~30KB. Plays well with log aggregators.

`pino` is the right pick: structured JSON out of the box (matches the spec's `LOG_FORMAT=json` boot-event idea), free child loggers (`pino().child({ plugin: 'memory' })`), and standard enough that operators already know it.

## Plan

1. Pick the logger lib (probably `pino ^9.x`).
2. Build a small `Logger` interface adapter so the public type stays stable while we swap implementations underneath.
3. `OracleApp.create()` builds the root logger once at boot.
4. Root logger goes into `AmbientServices` (already a field; just gets a real value instead of noop).
5. Plugins get `ctx.logger = rootLogger.child({ plugin: name })` — already wired through `buildRuntimeContext`, just a richer impl.
6. **Delete every `NoopLogger` usage** from internal modules. Modules that need a logger get one via ambient/context. Modules called outside the runtime (rare) default to a console adapter.
7. Update tests to spy on the chosen logger or pass an explicit fake — the existing `silentLogger()` helper in `plugin-loader.test.ts` is the right pattern.

## Acceptance

- [ ] `NoopLogger` does not appear in any source file under `packages/oracle-runtime/src/`.
- [ ] Default boot output includes structured logs with `plugin`, `event`, and `level` fields.
- [ ] Plugins still call `ctx.logger.info(...)` exactly as today — no plugin-author-facing change.
- [ ] Tests still pass with the same `silentLogger`/`vi.fn()` mock pattern.
- [ ] `OracleApp` exposes the root logger (e.g., `app.getLogger()`) for fork-side customization.
- [ ] One log line per status change at boot — no chattier than today.

## Out of scope

- Log shipping / aggregator integration (Datadog, ELK, Loki, etc.) — that's per-deploy.
- Custom log levels beyond the existing `log/info/warn/error/debug/verbose`.
- Replacing `console` calls in `apps/app/` or other packages — runtime-only for v1.

## Notes

- Today's `NoopLogger` lives in `packages/oracle-runtime/src/bootstrap/plugin-loader.ts` and `packages/oracle-runtime/src/bootstrap/schema-composer.ts`. Confirm via grep before starting.
- The `Logger` interface in `packages/oracle-runtime/src/plugin-api/types.ts` already has an optional `child(bindings)` method — pino's child logger fits perfectly.
- Plugin authors should never see `pino` directly. They consume `ctx.logger` typed as `Logger`. If we swap pino for something else later, plugin code is unaffected.

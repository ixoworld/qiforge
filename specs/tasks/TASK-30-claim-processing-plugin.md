# TASK-30: Convert `claimProcessingPlugin` (depends on credits)

**Phase:** 5 — Bundled plugin conversion
**Spec:** §16.1
**Effort:** 2 days
**Depends on:** TASK-29 (credits)
**Blocks:** TASK-32
**Parallel with:** other plugin conversion tasks (except TASK-29)

## Goal

Convert the claim-processing feature (signed claims + BullMQ claim worker, internal-only) into a plugin. Hard depends on credits. `visibility: 'silent'`.

## Deliverables

### Created

- `packages/oracle-runtime/src/plugins/claim-processing/claim-processing.plugin.ts` — class with `dependsOn: ['credits']`, manifest `visibility: 'silent'`, category `'core'`. The plugin contributes: any agent-callable tools for claims (if such exist today; verify against `apps/app/src/claim-processing/`).
- `packages/oracle-runtime/src/plugins/claim-processing/index.ts`
- `packages/oracle-runtime/src/plugins/claim-processing/claim-processing.plugin.test.ts`

### Moved (`git mv`)

- `apps/app/src/claim-processing/` → `packages/oracle-runtime/src/plugins/claim-processing/`. Includes `ClaimProcessingService`, the LangGraph `task()`/`entrypoint()` workflow per `apps/app/src/claim-processing/claim-processing.service.ts:53`.

### Modified

- The BullMQ claim worker stays internal — the agent doesn't define it. It's registered as part of the plugin's NestJS module (similar to TasksPlugin / TASK-31's pattern).
- `processHeldAmount()` (today line 312 of claim-processing.service.ts) is invoked by the token limiter (in TASK-29) when token thresholds are crossed. Cross-plugin invocation: token limiter calls `claimProcessingService.processHeldAmount` directly via DI within the runtime.

## Acceptance

- [ ] Plugin loads only when credits is loaded; otherwise excluded with a log line.
- [ ] BullMQ claim worker registered (internal, not agent-facing).
- [ ] `processHeldAmount` flow works: tokens cross threshold → claim worker submits intent → saves to Matrix → submits on-chain.
- [ ] Test: stubbed dependencies, simulate threshold crossing, verify worker is invoked.

## Out of scope

- New claim features.
- The credits plugin (TASK-29).

## Notes

- §16.1: cascade — disabling credits auto-disables claim-processing per §11.2.
- The processing workflow uses LangGraph `task()` and `entrypoint()` per `apps/app/src/claim-processing/claim-processing.service.ts:53`. Don't refactor the workflow itself; just relocate.
- Internal BullMQ wiring: per spec §3 non-goal #8, plugins don't define BullMQ workers via `getWorkers`. But this plugin's NestJS module ships internal BullMQ wiring for the claim worker, which the runtime imports when the feature is enabled. Same pattern as TASK-31 (tasks).

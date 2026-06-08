# TASK-31: Convert `tasksPlugin` (TasksModule + 4 BullMQ queues + sub-agent)

> **SUPERSEDED — port-as-is plan retired.**
> This task's original plan (1:1 port of `apps/app/src/tasks/` into a plugin folder) has been replaced by a clean-sheet rebuild. See **`specs/tasks-async-system.md`** for the active spec and phase plan. The notes below are kept only for historical context.

**Phase:** 5 — Bundled plugin conversion
**Spec:** ~~§16.1, §19.3~~ → `specs/tasks-async-system.md`
**Effort:** ~~5 days~~ → ~8.5 days (per rebuild spec)
**Depends on:** TASK-11, TASK-15
**Blocks:** TASK-32
**Parallel with:** other plugin conversion tasks

## Goal

Convert the Tasks feature (TasksModule, 4 BullMQ queues, scheduler, processors, task-manager sub-agent) into a plugin. The most coupled bundled plugin. Auto-detected via `REDIS_URL`. `visibility: 'always'`. Soft-depends on memory.

## Deliverables

### Created

- `packages/oracle-runtime/src/plugins/tasks/tasks.plugin.ts` — class per §19.3:
  - `softDependsOn: ['memory']`
  - `configSchema: { REDIS_URL: z.string() }`
  - Manifest with `visibility: 'always'`, category `'automation'`.
  - `getSubAgents(ctx)` returns `call_task_manager_agent` with conditional tools based on `ctx.availablePlugins.has('memory')`.
- `packages/oracle-runtime/src/plugins/tasks/index.ts`
- `packages/oracle-runtime/src/plugins/tasks/tasks.plugin.test.ts` covering:
  - Plugin loads when `REDIS_URL` set.
  - Sub-agent tool list includes `rememberTaskContext` when memory loaded; excludes it when memory not loaded.
  - BullMQ queues registered in test (using in-memory queue mock).

### Moved (`git mv`)

- `apps/app/src/tasks/` → `packages/oracle-runtime/src/plugins/tasks/internal/`. Whole directory: TasksModule, TasksScheduler, 4 processors (simple, work, deliver, approval), task-doc.spec.ts, task-page-template.spec.ts, tasks-scheduler.service.spec.ts.

### Modified

- `TasksModule` becomes the plugin's internal NestJS module. Loaded conditionally from `RuntimeAppModule` based on `features.tasks`.
- The task-manager sub-agent (today: `createTaskManagerAgent` per `apps/app/src/graph/agents/main-agent.ts:651`) — this is conditional in the current code (`matrix?.roomId && tasksService && userMatrixId`). In the plugin world, plugin's `getSubAgents` returns the sub-agent always (when plugin is loaded); the per-request conditions move into the sub-agent's handler logic (or the sub-agent's `condition` if we add that field — keep it simple, just early-return in the handler when conditions aren't met).

## Acceptance

- [ ] Plugin loads when `REDIS_URL` set; not loaded when absent.
- [ ] All 4 BullMQ queues (`task_simple`, `task_work`, `task_deliver`, `task_approval`) register correctly.
- [ ] All 4 processors (simple, work, deliver, approval) process jobs.
- [ ] Task-manager sub-agent appears in agent's tool list as `call_task_manager_agent`.
- [ ] Soft-dep test: plugin works without memory loaded; with memory, the sub-agent has the additional `rememberTaskContext` tool.
- [ ] Existing tests (`task-doc.spec.ts`, `task-page-template.spec.ts`, `tasks-scheduler.service.spec.ts`) pass after relocation.

## Out of scope

- New tasks features.
- The user-facing `getWorkers` field on the plugin — per §3 non-goal #8, plugins don't define BullMQ workers. The internal NestJS module owns the BullMQ wiring, which is fine because tasks is a BUNDLED plugin (not user-authored).

## Notes

- This is the largest task in Phase 5 — 5 days. The TasksModule is intricate.
- §19.3 has the plugin example structure. Follow it.
- BullMQ workers internally call `MatrixManager.getInstance()` per the matrix-storage review; preserve that. Don't refactor processors.
- Note: `failureMode: 'disable'` in v2 spec — in v3 absent. If init fails, runtime logs and skips. Tasks is `'auto'` by default (`REDIS_URL` presence), so usually it's a clean enable/disable.

## Re-implement during rebuild (removed during TASK-32b)

TASK-32b deleted approval-gate plumbing from MessagesService because it's tasks-coupled and the tasks plugin needs a clean redo anyway. When the plugin is rebuilt, restore these behaviors via the plugin (not via MessagesService stubs):

- **Approval gate interception** — Pre-LLM check that detects when a user message is responding to a pending approval request. Today's flow (in the deleted code): cheap Redis `GET` for a pending taskId in the room → LLM classification of the message text (`approved`/`rejected`/`other`) → `handleApprovalResponse({ taskId, approved, mainRoomId, rejectionReason })`. The plugin should own the entire pipeline; MessagesService should expose either an early `beforeChat` hook or a NestJS middleware that the tasks plugin installs via `getNestModules()`. **Add a keyword fast-path** before the LLM classify call — trivial yes/no/cancel matches should skip the model.
- **`tryHandleApprovalResponse` was called from two places**: the Portal sendMessage path (after `prepareForQuery`) AND inside the Matrix listener (`MatrixListenerBridge.handleMessage`, prior to `flushMatrixEvents`). The rebuild should ensure both ingress paths still get the gate.
- **`@Optional() approvalService: ApprovalService`** and **`@Optional() tasksService: TasksService`** injections were removed from `MessagesService`. Replace with proper plugin-owned ports (e.g. `APPROVAL_GATE_PORT` symbol token, `TASK_DISPATCH_PORT`) wired through Nest DI in the plugin's `getNestModules()`.
- **`classifyApprovalResponse(text)`** — the cheap LLM classifier was a stub in `forward-refs.ts` (returned null). Real implementation lives in the deleted `apps/app/src/tasks/...`. Carry it into the new plugin and call it via the gate port.
- **`isRedisEnabled()` + `TokenLimiter` stubs** were also in `forward-refs.ts` and have been deleted. The credits plugin now provides a `FILE_PROCESSING_CREDIT_SINK` (Nest token); if tasks ever needs to bill outside the agent graph, it should use the same pattern — define a port + have credits supply the adapter.

## File-processing credit deduction (preserved via different wiring)

Before TASK-32b, `MessagesService` deducted credits for file-processing LLM calls inline using `TokenLimiter.usdCostToCredits/limit` stubs. Now:

- `FileProcessingService` accepts `@Optional() @Inject(FILE_PROCESSING_CREDIT_SINK)`.
- The credits plugin's `getNestModules()` registers `FileProcessingSinkModule`, which provides the sink (a `TokenLimiter`-backed adapter).
- `processAttachments(attachments, roomId, userDid)` now deducts internally — no MessagesService coupling.

This means file processing is billed whenever credits is loaded, regardless of whether MessagesService imports a TokenLimiter. The wiring is clean and the tasks rebuild can copy it for any future "bill outside the agent" needs.

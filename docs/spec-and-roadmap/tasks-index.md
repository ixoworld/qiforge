# Tasks index — pointer

Full task index: `specs/tasks/README.md`. That file is the source of truth for what's done, what's open, and the dependency graph.

## Status snapshot

As of the last update to this doc:

- **Done:** 28 of 30 in-scope tasks.
- **TODO:** TASK-32 (replace `apps/app`), TASK-33 (CLI updates), TASK-34 (documentation — this one).
- **Removed:** TASK-16 (langfuse — replaced by `LANGSMITH_*` env vars on base schema).
- **Deferred:** TASK-18 (calls), TASK-31 (tasks).
- **Merged:** TASK-30 (claim-processing) into TASK-29 (credits).

See `specs/tasks/README.md` for the full status table and the dependency graph.

## Phase structure

| Phase | Tasks | Owns |
| --- | --- | --- |
| 1 — Foundation | TASK-01 … TASK-06 | Package skeleton, types, manifest, registries, loader, contexts, plugin API entry. |
| 2 — Discovery & Composition | TASK-07 … TASK-11 | `loadedPlugins` state field, meta-tools, agent builder, `createMainAgent`, `createOracleApp`. |
| 3 — Tier-0 module relocation | TASK-12 … TASK-14 | Move Sessions, Messages, WS, Secrets, UCAN, Auth, Subscription, Throttler, Matrix checkpointer into the runtime package. |
| 4 — Testing harness | TASK-15 | `createTestRuntime` + mocks. |
| 5 — Bundled plugin conversion | TASK-16 … TASK-31 | Convert each `apps/app` feature into a plugin under `packages/oracle-runtime/src/plugins/`. |
| 6 — Final integration | TASK-32 … TASK-34 | Replace `apps/app/`, update CLI, refresh docs. |

## Picking up a task

1. Read the spec section the task cites.
2. Read the task file's Deliverables and Acceptance sections.
3. Check Status in `specs/tasks/README.md` — confirm it's `TODO` and the `Depends on` row is `Done`.
4. Work through the acceptance checklist.
5. Update the status row when you finish.

## Beyond-spec work

The status notes section of `specs/tasks/README.md` lists work that landed beyond the original 34 tasks. Key additions:

- **`getRequestTools(rtCtx)` and `getRequestSubAgents(rtCtx)`** — for state-aware plugins (agui, portal). Not in the original spec but added during execution.
- **`getNestModules()`** — for plugins shipping NestJS modules (slack landed using this; tasks rebuild will use it).
- **`UcanAdapter.resolveServiceDid(url)`** — exposed so plugins don't roll their own did:web resolution.

These extensions are documented in the relevant architecture files. They didn't require a spec amendment — they're additive extensions of `OraclePlugin` and `RuntimeContext.ucan`.

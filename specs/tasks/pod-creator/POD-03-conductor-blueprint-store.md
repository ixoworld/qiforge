# POD‑03: Conductor + blueprint store

**Phase:** 2 — Conductor & specialists
**Spec:** §5, §7, §9
**Effort:** 3 days
**Depends on:** POD‑01
**Blocks:** POD‑04, POD‑05
**Parallel with:** POD‑02

## Goal

The conductor's orchestration tools plus the durable blueprint document. Stage and readiness are
**derived from completed blueprint sections** — no new core graph state field.

## Deliverables

### Created

- `packages/oracle-runtime/src/plugins/pod-creator/blueprint-store.ts` — read/write the per‑thread
  blueprint to a durable doc: the `editor` Y.Doc when `ctx.availablePlugins.has('editor')`, else
  Matrix room state via `ctx.matrix.postToRoom`. Typed sections keyed by stage/role.
- `packages/oracle-runtime/src/plugins/pod-creator/orchestration-tools.ts` — `start_pod_design`,
  `record_blueprint_section`, `get_blueprint`, `compute_readiness`, `assemble_blueprint`
  (→ `service_pod_blueprint`). Returned from `getTools()`.
- `packages/oracle-runtime/src/plugins/pod-creator/stage.ts` — `deriveStage(rt)` and
  `SPECIALISTS_FOR_STAGE`, following the §4 readiness pipeline.
- Tests.

## Acceptance

- [ ] `start_pod_design` initialises the blueprint doc for a thread.
- [ ] `record_blueprint_section` persists durably; survives a fresh `RuntimeContext` (re‑read from the doc).
- [ ] `compute_readiness` returns a score + blocker list from completed sections and gates correctly.
- [ ] `assemble_blueprint` only succeeds once the `qa_launch_readiness` section passes.
- [ ] `deriveStage` returns the correct next stage across the pipeline; re‑opens a stage when a downstream gate rejects.
- [ ] No field added to graph state (`loadedPlugins` stays the only addition).

## Out of scope

- The specialist sub‑agents (POD‑04) and the create path (POD‑05).

## Notes

- Conductor behaviour = manifest + these tools, not a system‑prompt rewrite.
- Keep the blueprint section schema small and typed; the create path (POD‑05) reads it directly.

# TASK-25: Convert `aguiPlugin`

**Phase:** 5 — Bundled plugin conversion
**Spec:** §16.1
**Effort:** 1.5 days
**Depends on:** TASK-11, TASK-15
**Blocks:** TASK-32
**Parallel with:** other plugin conversion tasks

## Goal

Convert the AG-UI (Portal copilot) feature into a plugin. Owns the existing `agActions` state field — does NOT rename it. `visibility: 'always'`.

## Deliverables

### Created

- `packages/oracle-runtime/src/plugins/agui/agui.plugin.ts` — class with manifest, `getSubAgents(ctx)` returning the AG-UI sub-agent. Conditional based on `state.agActions.length > 0` (per today's `main-agent.ts:504` conditional).
- `packages/oracle-runtime/src/plugins/agui/index.ts`
- `packages/oracle-runtime/src/plugins/agui/agui.plugin.test.ts`

### Moved (`git mv`)

- `apps/app/src/graph/agents/agui-agent.ts` → `packages/oracle-runtime/src/plugins/agui/agui-agent.ts`

## Acceptance

- [ ] Plugin loads.
- [ ] `call_agui_agent` tool appears when `state.agActions.length > 0`.
- [ ] AG-UI sub-agent works end-to-end (verified by replaying an existing test or invoking with stubbed actions).
- [ ] No state-field rename.
- [ ] Test: with mock `agActions` populated, sub-agent invocation returns expected response.

## Out of scope

- New AG-UI features.
- Renaming `agActions` state field.

## Notes

- The conditional sub-agent pattern (today: `main-agent.ts:504`) is now internal to the plugin's `getSubAgents`.
- `agActions` state field stays — just the plugin reads it.

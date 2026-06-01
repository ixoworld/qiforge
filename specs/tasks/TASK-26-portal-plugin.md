# TASK-26: Convert `portalPlugin`

**Phase:** 5 — Bundled plugin conversion
**Spec:** §16.1
**Effort:** 2 days
**Depends on:** TASK-11, TASK-15
**Blocks:** TASK-32
**Parallel with:** other plugin conversion tasks

## Goal

Convert the Portal feature (browser-tools-forwarded sub-agent) into a plugin. Owns the existing `browserTools` state field — does NOT rename it. `visibility: 'on-demand'`.

## Deliverables

### Created

- `packages/oracle-runtime/src/plugins/portal/portal.plugin.ts` — class with manifest, `getSubAgents(ctx)` returning the portal sub-agent with `forwardTools: true` and reading `state.browserTools`.
- `packages/oracle-runtime/src/plugins/portal/index.ts`
- `packages/oracle-runtime/src/plugins/portal/portal.plugin.test.ts`

### Moved (`git mv`)

- `apps/app/src/graph/agents/portal-agent.ts` → `packages/oracle-runtime/src/plugins/portal/portal-agent.ts`
- `apps/app/src/graph/agents/portal-agent.md` → `packages/oracle-runtime/src/plugins/portal/portal-agent.md`

## Acceptance

- [ ] Plugin loads.
- [ ] `call_portal_agent` tool appears (or is dynamically loadable since `'on-demand'`).
- [ ] Browser tools forwarded into the sub-agent's tool list correctly.
- [ ] No state-field rename.
- [ ] Test: with mock `browserTools` in state, sub-agent invocation works.

## Out of scope

- New portal features.

## Notes

- §16.1 has portal at `'on-demand'` — agent uses `find_capability`/`load_capability` to discover.
- `forwardTools: true` is the pattern from today's `createPortalAgent` — browser tools from `state.browserTools` are forwarded into the sub-agent's tools list.

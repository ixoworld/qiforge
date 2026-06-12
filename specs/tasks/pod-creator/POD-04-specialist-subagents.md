# POD‑04: Specialist sub‑agents (per‑stage, registry‑loaded)

**Phase:** 2 — Conductor & specialists
**Spec:** §5, §6, §11
**Effort:** 3 days
**Depends on:** POD‑02, POD‑03
**Blocks:** POD‑05

## Goal

Wire the 12 specialist roles as `PluginSubAgent`s via async `getRequestSubAgents` — gated per stage,
each with its `SKILL.md` fetched from the registry (POD‑02) as `systemPrompt`.

## Deliverables

### Created

- `packages/oracle-runtime/src/plugins/pod-creator/sub-agents.ts` — builds the per‑stage
  `PluginSubAgent[]`: reads `deriveStage(rt)`, fetches the role prompt(s) via `CapsuleContentClient`,
  sets `name: call_<role>`, the role's tools, `model: 'subagent'`, and `forwardTools`.
- Per‑role tool definitions (narrow): read prior sections, emit this section (via
  `record_blueprint_section`), validate; `service_architect` / `claims_architect` may call
  `domain-indexer` reads when that plugin is present.
- Tests.

### Modified

- `pod-creator.plugin.ts` — implement `getRequestSubAgents(rt)`.

## Acceptance

- [ ] At a given stage, `getRequestSubAgents` returns only that stage's specialist(s) — not all 12.
- [ ] Each returned sub‑agent's `systemPrompt` is the registry `SKILL.md` text (mocked registry in tests).
- [ ] The conductor can call `call_<role>`; the returned section lands in the blueprint via `record_blueprint_section`.
- [ ] `forwardTools` surfaces specialist tool‑calls into the main chat history.
- [ ] All 12 roles enumerated, each mapped to its capsule.

## Out of scope

- The create path (POD‑05). Embedding prompts — rejected; registry‑loaded per §3 (decision 5).

## Notes

- Needs the full role `SKILL.md`s + handoff fields to port each role's tools precisely (§12.3) —
  obtain via repo‑add / paste at build time.
- Sub‑agents are leaves; they don't call peers. Orchestration stays at the conductor (POD‑03).

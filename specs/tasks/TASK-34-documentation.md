# TASK-34: Documentation

**Phase:** 6 — Final integration
**Spec:** §22.17
**Effort:** 2 days
**Depends on:** TASK-33
**Blocks:** —

## Goal

Refresh all developer-facing docs to reflect the new plugin shape. After this task, a new contributor can onboard from docs alone.

## Deliverables

### Created

- `packages/oracle-runtime/README.md` — getting started, full API reference. Sections:
  - Install + 30-line starter.
  - Class-based plugin example (climate).
  - POJO plugin example.
  - Manifest reference.
  - Visibility / dynamic loading explained.
  - `RuntimeContext` reference.
  - Shared state pattern.
  - Linking to the spec for design context.
- `docs/playbook/plugins.md` — how to write a plugin (audience: fork developers). Pulls from §4-9, §19.
- `docs/playbook/manifests.md` — how to write a great manifest. Pulls from §5. Contrasts good vs bad examples.

### Updated

- `docs/playbook/01-quickstart.md` — reflect the new starter structure (§18) and the `qiforge plugin new` flow.
- `CLAUDE.md` — update "Architecture" section to reference the runtime package + plugin model. Drop references to old paths (`apps/app/src/graph/agents/main-agent.ts` etc.); they no longer exist.

## Acceptance

- [ ] A new developer reading `packages/oracle-runtime/README.md` end-to-end can write a working plugin.
- [ ] `docs/playbook/plugins.md` covers manifests, tools, sub-agents, middlewares, shared state, soft deps.
- [ ] `docs/playbook/manifests.md` has 5+ contrasting good-vs-bad manifest examples.
- [ ] `docs/playbook/01-quickstart.md` walks through a new fork creation using the new CLI.
- [ ] `CLAUDE.md` is consistent with the new structure (no broken references).
- [ ] All existing playbook files that reference deleted paths are updated.

## Out of scope

- Tutorial videos or screencasts.
- Migration guide for forks moving from the pre-transformation shape — there is no in-between (per §3 non-goal #9, this is a transformation, not a migration).
- Versioning policy doc (stability tiers, codemods, structured changelog) — deferred.

## Notes

- Per CLAUDE.md, this repo's playbook target audience is "non-technical humans + AI agents that will follow the playbook." Keep tone plain.
- Skills-first framing per CLAUDE.md still applies — but in the plugin world, "skills" are accessed via `skillsPlugin` (TASK-23). Update any framing that conflates skills with plugins to reflect the right mental model.
- After this task lands, the spec (`specs/ORA-219-plugin-based-runtime.md`) becomes a design archive. Day-to-day reference moves to the `packages/oracle-runtime/README.md` and the playbook.

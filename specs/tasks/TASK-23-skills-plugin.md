# TASK-23: Convert `skillsPlugin` (depends on sandbox)

**Phase:** 5 — Bundled plugin conversion
**Spec:** §16.1
**Effort:** 2 days
**Depends on:** TASK-22 (sandbox)
**Blocks:** TASK-32
**Parallel with:** other plugin conversion tasks

## Goal

Convert the skills feature (skills registry + UCAN-authenticated calls) into a plugin. Hard depends on sandbox. `visibility: 'always'`.

## Deliverables

### Created

- `packages/oracle-runtime/src/plugins/skills/skills.plugin.ts` — class with `dependsOn: ['sandbox']`, `configSchema: { SKILLS_CAPSULES_BASE_URL: z.string() }`, manifest with `visibility: 'always'`. `getTools(ctx)` returns `list_skills_tool` and `search_skills_tool` (today in `main-agent.ts:990+`).
- `packages/oracle-runtime/src/plugins/skills/index.ts`
- `packages/oracle-runtime/src/plugins/skills/skills.plugin.test.ts`

### Moved (`git mv`)

- Skills-related code from `apps/app/src/`. Search for `skills-tools` references; today there's `apps/app/src/graph/nodes/tools-node/skills-tools.ts` per CLAUDE.md.
- Move `list_skills_tool`, `search_skills_tool`, `UserSkillsService` into the plugin directory.

### Modified

- Skills tools use UCAN headers (`X-Skills-Invocation`); the plugin owns the UCAN-minting logic for skills calls.

## Acceptance

- [ ] Plugin loads when sandbox is loaded; boot fails with clear error if `dependsOn: ['sandbox']` is unmet.
- [ ] `list_skills_tool` and `search_skills_tool` work as today.
- [ ] UCAN-authenticated skills calls succeed (using `X-Skills-Invocation` header).
- [ ] Test: stubbed UserSkillsService returns mock skills; tools invoke correctly.

## Out of scope

- Building NEW skills features.
- The sandbox plugin (TASK-22).

## Notes

- §16.1: `dependsOn: ['sandbox']` enforced by the topo-sort.
- Today: `UserSkillsService.getInstance()` per CLAUDE.md — relocate into the plugin's directory but the singleton pattern can stay (instantiated by the plugin's class constructor or via DI).
- Verify all four files referenced in CLAUDE.md (`skills-tools.ts`, `skills-agent/`) are accounted for.

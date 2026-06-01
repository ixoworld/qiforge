# TASK-02: Manifest schema + validator

**Phase:** 1 — Foundation
**Spec:** §5
**Effort:** 1 day
**Depends on:** TASK-01
**Blocks:** TASK-03, TASK-07

## Goal

Define the Zod schema for `PluginManifest` and ship the boot-time validator. Validation rules from §5.5 are enforced at registry-population time.

## Deliverables

### Created

- `packages/oracle-runtime/src/manifest/schema.ts` — Zod schema for `PluginManifest` per §5.1.
- `packages/oracle-runtime/src/manifest/validator.ts` — `validateManifest(plugin)` function:
  - Hard rules (boot warning, plugin loads in degraded discovery mode if violated):
    - `summary` non-empty
    - `whenToUse` ≥ 1 entry if `visibility !== 'silent'`
    - `examples[].tool` references a tool actually registered by this plugin (cross-check happens later in TASK-03 collision pass)
    - `tags` lowercase if present
  - Soft rules (warned only):
    - `summary` ≤ 120 chars
    - `whenToUse` ≤ 8 bullets, each ≤ 100 chars
- Unit tests covering each rule: valid manifest, missing summary, no whenToUse for `'always'` plugin, lowercase tag check, soft cap warning.

### Modified

- `packages/oracle-runtime/src/index.ts` — export the schema for plugin authors to type against if needed.

## Acceptance

- [ ] Calling the validator with a valid manifest returns `{ valid: true, warnings: [] }`.
- [ ] Calling with a missing `summary` returns `{ valid: false, errors: [...] }` naming the field.
- [ ] Calling with `visibility: 'always'` and empty `whenToUse` returns an error.
- [ ] Soft rules emit warnings without failing.
- [ ] Cross-tool-reference check is exposed as `validateExamplesAgainstTools(manifest, toolNames)` so TASK-03 can wire it during registry population.

## Out of scope

- Cross-plugin collision detection (TASK-03).
- TF-IDF / search indexing (TASK-07).
- Tier-1 rendering (TASK-07).

## Notes

- §5.5 lists every constraint. Don't add new ones.
- Errors should name the offending plugin and field path so boot logs are actionable per §15.4.

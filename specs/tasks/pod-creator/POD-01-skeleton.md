# POD‑01: Plugin skeleton + manifest

**Phase:** 1 — Foundation
**Spec:** §1, §2, §3, §5, §10
**Effort:** 1.5 days
**Depends on:** —
**Blocks:** all subsequent POD tasks

## Goal

Create the `pod-creator` bundled plugin shell — class extending `OraclePlugin`, manifest,
`configSchema`, dependencies — and register it in `BUNDLED_PLUGINS`. Boots cleanly with no
sub‑agents and no create path yet, so later tasks have a place to land.

## Deliverables

### Created

- `packages/oracle-runtime/src/plugins/pod-creator/pod-creator.plugin.ts` — `class PodCreatorPlugin
  extends OraclePlugin`: `name = 'pod-creator'`, `version`, `manifest` (`category: 'automation'`,
  `visibility: 'on-demand'`, `whenToUse` / `examples` that teach the conductor to drive POD
  creation), `dependsOn: ['agui']`, `softDependsOn: ['editor', 'domain-indexer', 'memory']`,
  `configSchema` per §10 (marketplace endpoint, per‑stage toggles, `mainnet` opt‑in; reuse
  `SKILLS_CAPSULES_BASE_URL`).
- `packages/oracle-runtime/src/plugins/pod-creator/index.ts` — barrel export.
- `packages/oracle-runtime/src/plugins/pod-creator/pod-creator.plugin.test.ts`.

### Modified

- `packages/oracle-runtime/src/plugins/index.ts` — add `PodCreatorPlugin` to `BUNDLED_PLUGINS`.

## Acceptance

- [ ] Plugin loads via the loader; `dependsOn: ['agui']` enforced by the topo‑sort (clear boot error if `agui` is absent).
- [ ] `configSchema` merges into the runtime env schema; a missing required var fails boot with a clear message.
- [ ] Manifest is discoverable via `list_capabilities`; `load_capability('pod-creator')` succeeds.
- [ ] Test (`createTestRuntime`): plugin registers; manifest fields present; exposes no tools/sub‑agents yet.

## Out of scope

- Sub‑agents (POD‑04), orchestration/create tools (POD‑03 / POD‑05), capsule loading (POD‑02).

## Notes

- `visibility: 'on-demand'` — a heavy capability loaded on intent. A fork whose sole purpose is POD
  creation may set `always`.
- Conductor persona is realised through the manifest + orchestration tools (POD‑03), **not** a
  system‑prompt rewrite.

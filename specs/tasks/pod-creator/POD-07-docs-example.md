# POD‑07: Docs + example wiring

**Phase:** 4 — Integration & docs
**Spec:** §13, §14, §15
**Effort:** 2 days
**Depends on:** POD‑05, POD‑06
**Blocks:** —

## Goal

Document the plugin across both doc surfaces and provide a walkthrough; optionally wire it into the
example oracle.

## Deliverables

### Created

- **Public docs** (`build-an-oracle`): a `pod-creator` catalogue page — purpose, env, the
  approval/signing UX, and the Portal `sign_transaction` handler requirement.
- **Internal docs** (`docs/architecture`): the lifecycle state machine, the registry‑loaded
  sub‑agent pattern, and the prepare → approve → sign → confirm create path.
- `packages/oracle-runtime/src/plugins/pod-creator/POD-PLUGIN.md` — a walkthrough mirroring
  `apps/qiforge-example/WEATHER-PLUGIN.md`.

### Modified

- Optional: `apps/qiforge-example/src/main.ts` — enable `pod-creator` in the example plugin set.

## Acceptance

- [ ] Public catalogue page documents env, the UX, and the Portal handler dependency.
- [ ] Internal architecture page covers the lifecycle + create path.
- [ ] `POD-PLUGIN.md` walks a developer from intent → live POD.
- [ ] If wired into the example: `apps/qiforge-example` builds with the plugin enabled.

## Out of scope

- The Portal wallet handler implementation — external (§10).
- The operate / steward phase (§16).

## Notes

- Update both doc surfaces; link, don't duplicate (CLAUDE.md doc rule).

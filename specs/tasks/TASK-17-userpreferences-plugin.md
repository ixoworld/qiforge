# TASK-17: Convert `userPreferencesPlugin` (silent)

**Phase:** 5 — Bundled plugin conversion
**Spec:** §16.1
**Effort:** 1 day
**Depends on:** TASK-11, TASK-15
**Blocks:** TASK-32
**Parallel with:** other plugin conversion tasks

## Goal

Convert the user-preferences feature (added in PR #189) into a silent plugin. Owns the existing `userPreferences` state field — does NOT rename it (per non-goal #4, state.ts keys stay as-is).

## Deliverables

### Created

- `packages/oracle-runtime/src/plugins/user-preferences/user-preferences.plugin.ts` — class `UserPreferencesPlugin extends OraclePlugin`. Manifest: title "User Preferences", `visibility: 'silent'`, category `'core'`. `getMiddlewares()` returns the middleware that loads + injects user preferences into state on each request.
- `packages/oracle-runtime/src/plugins/user-preferences/index.ts`
- `packages/oracle-runtime/src/plugins/user-preferences/user-preferences.plugin.test.ts`

### Moved (`git mv`)

- `apps/app/src/user-preferences/` → `packages/oracle-runtime/src/plugins/user-preferences/service/` (the NestJS service stays a service; the plugin is a thin wrapper around it).

## Acceptance

- [ ] Plugin loads, contributes its middleware.
- [ ] User-preferences middleware populates `state.userPreferences` per the existing behavior in PR #189.
- [ ] No state-field rename — `userPreferences` field unchanged in `state.ts`.
- [ ] No agent-visible tools.
- [ ] Test: invoking the middleware with a mock `UserPreferencesService` populates state.

## Out of scope

- Building NEW user-preferences tools or features.
- Renaming the state field. Stays `userPreferences`.
- Exposing user preferences via `getSharedState()` for now — internal only. Other plugins read it from state directly via `runtime.context.state.userPreferences`.

## Notes

- The `UserPreferencesService` singleton is initialized in `apps/app/src/main.ts:110`. After this task, the bootstrap initializes it within the plugin's class constructor or via `RuntimeAppModule` DI.
- §16.1 catalog lists this as silent — the agent doesn't decide to use it; it's enrichment middleware.

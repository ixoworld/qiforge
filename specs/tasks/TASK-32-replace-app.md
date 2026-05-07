# TASK-32: Replace `apps/app/src/` with starter

**Phase:** 6 — Final integration
**Spec:** §18, §19, §22.14
**Effort:** 1 day
**Depends on:** all of TASK-16 … TASK-31 (every bundled plugin converted)
**Blocks:** TASK-33

## Goal

Delete the now-redundant contents of `apps/app/src/` and replace with the 30-line starter `main.ts`. This is the cleanliness payoff — the moment when the new shape is fully visible and the old jargon is gone.

## Deliverables

### Deleted

- `apps/app/src/graph/` — moved to runtime in TASK-09 and TASK-10.
- `apps/app/src/sessions/` — moved in TASK-12.
- `apps/app/src/messages/` — moved in TASK-12.
- `apps/app/src/ws/` — moved in TASK-12.
- `apps/app/src/secrets/` — moved in TASK-13.
- `apps/app/src/ucan/` — moved in TASK-13.
- `apps/app/src/middleware/` — auth-header moved in TASK-13, subscription moved in TASK-14.
- `apps/app/src/calls/` — moved to plugin in TASK-18.
- `apps/app/src/claim-processing/` — moved to plugin in TASK-30.
- `apps/app/src/slack/` — moved to plugin in TASK-28.
- `apps/app/src/tasks/` — moved to plugin in TASK-31.
- `apps/app/src/user-matrix-sqlite-sync-service/` — moved in TASK-14.
- `apps/app/src/user-preferences/` — moved to plugin in TASK-17.
- `apps/app/src/utils/` — relocate any used helpers into the runtime; delete unused.
- `apps/app/src/types.ts` — relocate types into runtime if still referenced; delete otherwise.
- `apps/app/src/app.controller.ts`, `app.controller.spec.ts`, `app.service.ts` — delete (they're skeletons).
- `apps/app/src/app.module.ts` — delete (replaced by `RuntimeAppModule` from runtime).
- `apps/app/src/config.ts` — delete (Tier-0 schema moved to runtime in TASK-14).
- `apps/app/src/main.ts` — replace with the new starter per §18.2.

### Created

- `apps/app/src/main.ts` — the 30-line starter per §18.2:
  ```ts
  import { createOracleApp } from '@ixo/oracle-runtime';

  async function bootstrap() {
    const app = await createOracleApp({
      identity: {
        name: process.env.ORACLE_NAME!,
        org: '...',
        description: '...',
        entityDid: process.env.ORACLE_ENTITY_DID!,
      },
      features: {},
      plugins: [],
    });
    await app.listen(parseInt(process.env.PORT ?? '3000', 10));
  }

  bootstrap().catch((err) => {
    console.error('Failed to start oracle:', err);
    process.exit(1);
  });
  ```
- `apps/app/src/plugins/` — empty directory with `.gitkeep`. Where developer-authored plugins live in a fork.

### Modified

- `apps/app/package.json` — remove dependencies on packages that moved into runtime (e.g., direct LangGraph deps, internal modules); add `@ixo/oracle-runtime` as a workspace dep.

## Acceptance

- [ ] `pnpm install` resolves cleanly.
- [ ] `pnpm dev` (or `pnpm start:dev`) boots the app and accepts HTTP requests.
- [ ] All bundled features work as before — Memory, Slack, Tasks, etc. (where their feature flags are auto-detected from env).
- [ ] `apps/app/src/` contains only `main.ts`, optional `plugins/.gitkeep`, optional `controllers/`, optional `modules/` for fork's NestJS modules.
- [ ] All existing E2E behaviors (verified by manually testing chat, sessions, secrets) work.
- [ ] No imports from deleted paths remain anywhere in the workspace (run a tree-wide grep).

## Out of scope

- Adding new fork-specific plugins to the starter — that's per-fork, not part of this task.
- The `oracle.config.json` migration — if the file is still used, move it into the new `main.ts` as inline config. If it has fork-specific identity overrides, that's per-fork.

## Notes

- This is the destructive task. Take a snapshot (git tag) before merging just in case.
- Verify each `git rm` is paired with a `git mv` from a previous task — there should be no logic that gets deleted without being relocated.
- The "old jargon" the user worried about is wholly resolved here. After this task, the diff between the starter `apps/app/src/` and an external fork is essentially the plugins they've authored.

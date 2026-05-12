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

---

## Sub-task decomposition

TASK-32 is too big for a single subagent run. Split into 5 sequential chunks tracked separately:

### TASK-32a — Production `AmbientServices` factory

Build the production factory inside `createOracleApp`. Today `AmbientServices` (matrix, ucan, llm, secrets, emit, logger) is constructed only in test fixtures. Production runtime requests can't reach `createMainAgent` with a working ambient bag.

Wire:
- `UcanService` → `UcanAdapter` (`mintInvocation`, `hasCapability`, `requireCapability`, `resolveServiceDid`)
- `MatrixManager` → `MatrixAdapter` (`postToRoom`, `getRoomState`, `getEventById`)
- `LlmAdapter` — lift `getProviderChatModel` logic, modernize against the role registry
- `SecretsAdapter` — from existing `SecretsService`
- `EmitAdapter` — wire to the WebSocket gateway

**Reuse policy applies:** Lift first, only reimpl if a lifted piece violates the plugin contracts. Surface and confirm before rewriting.

### TASK-32b — Rewire messages controller to `createMainAgent`

The Tier-0 messages controller (`packages/oracle-runtime/src/modules/messages/messages.controller.ts` + service) was lifted from apps/app and still builds the agent the OLD monolith way.

Rewire:
1. On each request, build per-request `RuntimeContext` from auth headers + state + the AmbientServices from 32a
2. Invoke `createMainAgent({ registries, ambient, identity, requestCtx })` using the booted runtime's registries
3. Stream result via SSE/WS (existing flow shape)

Depends on 32a.

### TASK-32c — New `apps/app/src/main.ts` starter

The ~30-line entry per §18.2:

```ts
import { createOracleApp, CreditsPlugin, EditorPlugin, ClaimProcessingPlugin } from '@ixo/oracle-runtime';
import { createClient as createMatrixJsClient } from 'matrix-js-sdk';
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL!);
const matrixJsClient = createMatrixJsClient({
  baseUrl: process.env.MATRIX_BASE_URL!,
  userId: process.env.MATRIX_ORACLE_ADMIN_USER_ID!,
  accessToken: process.env.MATRIX_ORACLE_ADMIN_ACCESS_TOKEN!,
});

const app = await createOracleApp({
  identity: {
    name: process.env.ORACLE_NAME!,
    org: 'IXO',
    description: '…',
    entityDid: process.env.ORACLE_ENTITY_DID!,
  },
  plugins: [
    new CreditsPlugin({ redis }),
    new ClaimProcessingPlugin({ redis }),  // same Redis — both plugins build their own TokenLimiter internally
    new EditorPlugin({ matrixClient: matrixJsClient }),
  ],
});
await app.listen();
```

Also: resolve the ClaimProcessingPlugin.getNestModules() wiring per the simple "pass redis, plugins build their own TokenLimiter" pattern. Depends on 32a, 32b.

### TASK-32d — Delete obsolete `apps/app/src/` files

Per the Deleted list above. Verify each path's relocation in the runtime exists, then `git rm`. Some paths are NOT relocated (e.g. calls and tasks — both deferred), so they get deleted without a corresponding move and their functionality is OUT of scope for the starter. Document in the commit message which deletions correspond to which TASK-XX. Depends on 32c.

### TASK-32e — End-to-end smoke verification

Real boot. Real HTTP request. Real graph invocation. Real plugin tool firing.

Use curl (or oracles-client-sdk) against a locally-booted oracle. Verify:
1. App starts via the new `main.ts`
2. Plugins resolve and register correctly (status report from `app.plugins.status()`)
3. A chat message reaches the agent
4. At least one plugin tool executes (e.g. memory search, domain-indexer lookup)
5. UCAN flows through correctly (no OpenID anywhere)
6. Credits middleware enforces budgets
7. Matrix room messages get logged

Document the smoke procedure in `specs/notes/task-32-smoke.md` so it's reproducible.

Depends on 32d.

# TASK-13 cleanup notes — Secrets, UCAN, Auth modules

Date: 2026-05-07

## What landed

Three modules copied (not git-mv'd) from `apps/app/src/` to
`packages/oracle-runtime/src/modules/`:

| Module    | Source                                          | Destination                         |
| --------- | ----------------------------------------------- | ----------------------------------- |
| secrets   | `apps/app/src/secrets/`                         | `modules/secrets/`                  |
| ucan      | `apps/app/src/ucan/`                            | `modules/ucan/`                     |
| auth      | `apps/app/src/middleware/auth-header.middleware.ts` | `modules/auth/auth-header.middleware.ts` (+ `auth.module.ts`) |

apps/app's originals were intentionally left untouched — TASK-32 deletes
them when apps/app is fully retired.

## UCAN-only auth chain — what was removed

The relocated `auth-header.middleware.ts` is **UCAN-only**. The Matrix
OpenID branch (lines 268–308 of the original) was deleted. Specifically:

- Dropped the `verifyMatrixOpenIdToken` import from `@ixo/common`.
- Dropped the `validateToken` helper (only existed to verify OpenID
  tokens).
- Dropped the OpenID validation cache (the 3-min `user_<sha256>` cache).
- Dropped the `getAuthHeaders` and `normalizeDid` calls (those parsed
  `x-matrix-access-token` and `@did-…` Matrix usernames — neither is
  needed for UCAN).
- Dropped `userOpenIdToken` from the `req.authData` shape. The new
  contract is exactly `{ did, homeServer, ucanDelegation }` with
  `ucanDelegation` REQUIRED.
- Requests without `x-ucan-delegation` → 401.
- Requests where UCAN validation fails → 401 (no fallback).

The 3-min UCAN delegation cache (`ucan_auth_<sha256>` key) is preserved
unchanged. `ucanService.cacheDelegation()` is still called on both cache
hits and validation passes so downstream invocations see the raw
delegation.

`req.authData.homeServer` stays as a field but is `''` for UCAN-only
auth — it carries no data today; kept for API symmetry until a
follow-up trims it.

## Other small relocations

- `import type { ENV } from 'src/config'` (apps/app-only path alias)
  dropped from `ucan.service.ts`. Replaced `ConfigService<ENV>` with
  the generic `ConfigService`. The narrow `keyof ENV` cast on
  `BLOCKSYNC_GRAPHQL_URL` was unnecessary; `configService.get<string>(...)`
  is now used directly.
- All references to TASK numbers, ORA-219, and `§` markers were stripped
  from copied source. Comments retained describe runtime behavior only.

## Tests added

- `auth-header.middleware.test.ts` — 5 tests:
  - 401 when `x-ucan-delegation` is missing.
  - 401 when `ORACLE_DID` not configured.
  - cache hit path populates `req.authData` with the right shape.
  - validation path populates `req.authData` and seeds both caches.
  - 401 when `validateDelegation` returns `ok: false`.
- `secrets.service.test.ts` — 7 tests for singleton, index filtering,
  cache hit/miss for values, encryption-key gating.
- `ucan.service.test.ts` — 11 tests for config defaults, signing-key
  flag, delegation cache TTL, capability URI building, replay
  detection.

22 tests total for TASK-13; full oracle-runtime test count goes from 134
(baseline) to ~209 (with concurrent meta-tools/etc tests also passing).

## Concurrent-task interactions to flag

Other TASK-12/TASK-14 work-in-progress files were already present
(uncommitted) under `packages/oracle-runtime/src/modules/`:

- `modules/messages/dto/send-message.dto.ts` — has
  `userMatrixOpenIdToken: string` (DTO consumed by the message
  controller). Needs to drop on TASK-12.
- `modules/sessions/auth-data.d.ts` — declares `userOpenIdToken?: string`
  in its `Express.Request.authData` augmentation. Conflicts with the
  UCAN-only declaration in `auth-header.middleware.ts`. **TASK-12 must
  delete this `.d.ts` so a single `declare global` (the one in the auth
  middleware) wins.**
- `modules/sessions/sessions.controller.ts` and
  `sessions.service.ts` — destructure `userOpenIdToken` off
  `req.authData`. TASK-12 needs to switch these to
  `ucanDelegation` and use `ucanService.createServiceInvocation` to mint
  a service invocation when the sessions service needs to call
  Matrix on the user's behalf.
- `modules/subscription/subscription.middleware.ts` —
  also has its own `declare global` augmentation including
  `userOpenIdToken: string` and reads `userOpenIdToken: matrixAccessToken`
  off `req.authData`. TASK-14 must align: drop the duplicate `declare
  global` and switch the subscription lookup to use `req.authData.did`
  (that's already the primary key for the subscription cache).

These conflicts are why a current full
`pnpm --filter @ixo/oracle-runtime build` reports type errors — none of
the errors come from the three modules TASK-13 produced. With the
TASK-13 modules in isolation (concurrent WIP set aside), `tsc` is clean.

## apps/app callers that still depend on `userOpenIdToken`

For TASK-32's hit-list — these references remain in the untouched
apps/app and will break once apps/app is migrated to the runtime
package:

- `apps/app/src/messages/messages.controller.ts:84` — destructures
  `userOpenIdToken` from `req.authData`.
- `apps/app/src/messages/messages.service.ts:1594` — passes the token
  through to graph invocation.
- `apps/app/src/sessions/sessions.controller.ts:43, 108-118` —
  uses `userOpenIdToken` for Matrix client init.
- `apps/app/src/middleware/subscription.middleware.ts:82` —
  destructures `userOpenIdToken: matrixAccessToken`.
- `apps/app/src/tasks/processors/work.processor.ts:144-199` — reads
  encrypted user token from job payload, decrypts as `matrixOpenIdToken`.
- `apps/app/src/graph/agents/main-agent.ts` — multiple uses of
  `configurable.configs?.user.matrixOpenIdToken` for downstream
  HTTP/MCP calls. Needs replacement with UCAN-minted invocations
  (`UcanService.createServiceInvocation`).

These all need replacing with UCAN flows during the apps/app cleanup
phase. The relocated UCAN module already exposes everything required
(`createServiceInvocation`, `cacheDelegation`, `getCachedDelegation`).

## Quirks / non-decisions

- `SecretsService` stays a singleton (`getInstance()`), as the task
  brief instructed. TASK-FOLLOWUP-logger / DI cleanup will revisit.
- The placeholder `validateMCPInvocation` in `UcanService` was
  preserved verbatim — refactor is explicitly out of scope.
- `homeServer: ''` on `req.authData` is intentional — the field is
  carried only for compatibility with downstream services. It should
  be re-evaluated once consumers of `req.authData.homeServer` are
  audited; remove if no real consumer remains.
- The `experimentalDecorators` + `emitDecoratorMetadata` flags were
  added to `packages/oracle-runtime/tsconfig.json` to support the
  NestJS class-based services brought in by this task. This is
  required for any future module using `@Injectable`, `@Inject`, etc.

# TASK-13: Secrets, UCAN, Auth modules relocate

**Phase:** 3 — Tier-0 module relocation
**Spec:** §22.10
**Effort:** 2 days
**Depends on:** TASK-05
**Blocks:** TASK-11
**Parallel with:** TASK-12, TASK-14

## Goal

Move the auth-chain modules (Secrets, UCAN, AuthHeaderMiddleware) into the runtime package. **No logic changes.** These three are grouped because they form the request authentication chain.

## Deliverables

### Moved (`git mv`)

- `apps/app/src/secrets/` → `packages/oracle-runtime/src/modules/secrets/`
- `apps/app/src/ucan/` → `packages/oracle-runtime/src/modules/ucan/`
- `apps/app/src/middleware/auth-header.middleware.ts` → `packages/oracle-runtime/src/modules/auth/auth-header.middleware.ts`
- Any related auth files (e.g. `auth-header.middleware.spec.ts` if it exists) follow.

### Created

- `packages/oracle-runtime/src/modules/auth/auth.module.ts` — wraps the auth-header middleware as a NestJS module if not already done. Apply via `RuntimeAppModule.configure()` to all routes.

### Modified

- Update imports inside moved files.
- Wire into `packages/oracle-runtime/src/bootstrap/runtime-app-module.ts`.
- Existing tests pass.

## Acceptance

- [ ] All three modules importable from runtime.
- [ ] `req.authData = { did, homeServer, ucanDelegation }` is populated correctly. **UCAN-only**: drop the Matrix OpenID token fallback that exists in today's `apps/app/src/middleware/auth-header.middleware.ts:26-36`. Requests without a valid `x-ucan-delegation` header → 401. The relocated middleware no longer accepts `x-matrix-access-token` as a fallback.
- [ ] UCAN delegation validation cache (3-min TTL) preserved.
- [ ] Matrix OpenID token validation cache (3-min TTL) preserved.
- [ ] `SecretsService.getSecretIndex(roomId)` works identically — same JWE decryption, 24h cache.
- [ ] `UcanService.cacheDelegation`, `validateMCPInvocation` etc. unchanged.

## Out of scope

- Adding caching for `getSecretIndex` (that's a Matrix-storage scaling fix tracked in `../matrix-storage-architecture-review.md`, not part of this task).
- Subscription middleware (TASK-14).
- Plugin auth composition rules (§6.5) — handled at the plugin loader level, not in these modules.

## Notes

- The auth chain order is: AuthHeader → Subscription (TASK-14) → Throttler (TASK-14).
- UCAN current implementation has a placeholder `validateMCPInvocation` per `apps/app/src/ucan/ucan.service.ts:555-610`. Don't refactor — just relocate.

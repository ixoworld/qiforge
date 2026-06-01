# TASK-14: Subscription, Throttler, Matrix checkpointer, Tier-0 env schema relocate

**Phase:** 3 — Tier-0 module relocation
**Spec:** §22.10, §17, §3 non-goal #2
**Effort:** 1.5 days
**Depends on:** TASK-05
**Blocks:** TASK-11
**Parallel with:** TASK-12, TASK-13

## Goal

Move the remaining Tier-0 pieces: subscription middleware, throttler, the Matrix-backed SQLite checkpointer (untouched per non-goal #2), and the Tier-0 env schema. **No logic changes.**

## Deliverables

### Moved (`git mv`)

- `apps/app/src/middleware/subscription.middleware.ts` → `packages/oracle-runtime/src/modules/subscription/subscription.middleware.ts`
- `apps/app/src/user-matrix-sqlite-sync-service/` → `packages/oracle-runtime/src/matrix/checkpointer/`
- (Throttler is configured in `app.module.ts:53-57` directly; relocate that config into `RuntimeAppModule`.)

### Created

- `packages/oracle-runtime/src/modules/subscription/subscription.module.ts` — wraps the middleware.
- `packages/oracle-runtime/src/modules/throttler/throttler.module.ts` — re-exports `ThrottlerModule.forRoot([{ ttl: 60000, limit: 10 }])` matching today's `apps/app/src/app.module.ts:53-57`.
- `packages/oracle-runtime/src/config/base-env-schema.ts` — extract Tier-0 env vars from today's `apps/app/src/config.ts` (40+ vars → ~22 Tier-0 vars per §17.1). Plugin-owned vars stay with their plugins (they'll add via `configSchema` in their respective conversion tasks).

### Modified

- `apps/app/src/config.ts` — remove plugin-owned env vars (those move to plugin `configSchema`s in Phase 5). Keep the file for now as a re-export shim until TASK-32 deletes it.
- Wire all into `RuntimeAppModule`.
- Existing tests pass.

## Acceptance

- [ ] Subscription middleware throws `HttpException(402)` if `subscription.status` not `active|trial` or credits ≤ 10 (per `apps/app/src/middleware/subscription.middleware.ts:52-65`).
- [ ] Throttler global rate-limit: 10 req / 60s. Verified via `RuntimeAppModule.imports`.
- [ ] `UserMatrixSqliteSyncService` works identically — same `getUserDatabase`, `markUserActive`, `markUserInactive`, the two crons (`uploadCheckpointToMatrixStorageTask`, `localStorageCacheCleanUpTask`).
- [ ] Tier-0 env schema parses all current Tier-0 env vars per §17.1.
- [ ] Plugin-owned env vars (e.g. `COMPOSIO_API_KEY`, `SLACK_BOT_OAUTH_TOKEN`, `MEMORY_MCP_URL`) are NOT in the Tier-0 schema — they'll move to plugins in Phase 5.

## Out of scope

- ANY changes to the checkpointer logic. It's a landmine per §3 non-goal #2. Pure relocation.
- Plugin-owned env var migration — that happens per plugin in Phase 5.
- Storage scaling fixes — tracked separately in `../matrix-storage-architecture-review.md`.

## Notes

- The checkpointer is the trickiest piece in the codebase. Treat the move as `git mv` + import-path fixes, nothing more. Do NOT refactor.
- Tier-0 env vars per §17.1: NODE*ENV, PORT, ORACLE_NAME, CORS_ORIGIN, NETWORK, MATRIX*\*, SQLITE_DATABASE_PATH, MATRIX_STORE_PATH, BLOCKSYNC_GRAPHQL_URL, MATRIX_ACCOUNT_ROOM_ID, MATRIX_VALUE_PIN, ORACLE_ENTITY_DID, ORACLE_SECRETS, SECP_MNEMONIC, RPC_URL, LLM_PROVIDER, OPENAI_API_KEY, OPEN_ROUTER_API_KEY, NEBIUS_API_KEY, LIVE_AGENT_AUTH_API_KEY.
- Plugin-owned vars (don't put in Tier-0): per §17.2 — Composio, Langfuse, Slack, Memory, Firecrawl, Domain Indexer, Sandbox, Skills, Credits, Tasks (`REDIS_URL`).

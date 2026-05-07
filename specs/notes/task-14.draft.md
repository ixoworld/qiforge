# task-14 cleanup notes

Tier-0 module relocation: subscription middleware, throttler config, Matrix
checkpointer, base env schema. Sources copied COPY-style from apps/app into
packages/oracle-runtime/. Originals untouched (apps/app continues to build
and run from its own copies until apps/app deletion).

## Decisions

### subscription middleware — port-based DI for plugin-owned dependencies

The original `apps/app/src/middleware/subscription.middleware.ts` imports
two cross-cutting things that don't belong inside the runtime core:

- `TokenLimiter` from `src/utils/token-limit-handler` — Redis-backed, owned
  by the credits/tasks plugins per spec env-var ownership table
- `UcanService` from `src/ucan/` — relocation target of a parallel task

The cleaned copy replaces these with two `@Optional() @Inject(SYMBOL)` ports
defined in the middleware itself:

- `SUBSCRIPTION_UCAN_PORT` — `{ hasSigningKey, createServiceInvocation }`.
  Wired by the relocated UCAN module.
- `SUBSCRIPTION_CREDIT_SINK` — `{ setSubscriptionPayload, overrideUserBalance }`.
  Wired by the credits plugin once it lands.

When neither port is present, the middleware still enforces the 402 gate
(status not active|trial OR totalCredits ≤ 10) using only the API response
and the cache-manager. No Redis dependency.

`req.authData` is read via a local `AuthDataShape` interface plus a typed
cast rather than a global `Express.Request` declaration-merge. The auth
module owns that augmentation; this file stays decoupled.

The `ENV` type import was dropped — the middleware now uses
`ConfigService` directly with explicit string keys (`'NETWORK'`,
`'SUBSCRIPTION_URL'`, `'DISABLE_CREDITS'`). Behaviour identical.

Dead-comment cleanup: removed two redundant log lines in the cached-path
branch and one redundant `JSON.stringify` debug log in the API-fetch path.

### throttler module — verbatim policy

Tiny re-export wrapper around `ThrottlerModule.forRoot([{ ttl: 60000,
limit: 10 }])`, matching `apps/app/src/app.module.ts:53-57`. The
`ThrottlerGuard` registration via `APP_GUARD` stays with `RuntimeAppModule`
since the guard binding is global (per-app, not per-module).

### checkpointer — pure relocation, two strict-mode safety swaps

Per the spec non-goal #2 the Matrix-backed SQLite checkpointer is a
relocation only. Diffs vs. apps/app:

- `matrix-upload-utils.ts`: 0 changes
- `type.ts`: 0 changes
- `user-matrix-sqlite-sync-service.module.ts`: 1 line (`.js` extension)
- `user-matrix-sqlite-sync-service.service.ts`: 5 lines:
  - 3 import paths get the `.js` ESM extension; `getConfig` now resolves
    via `../../config/base-env-config.js` (see next section)
  - `result[0].integrity_check` → `result[0]?.integrity_check` (the
    surrounding `result.length === 1 &&` guarantees the element exists at
    runtime; the `?.` only satisfies `noUncheckedIndexedAccess`)
  - `error.message` → `error instanceof Error ? error.message : String(error)`
    inside a `catch (error)` block — same runtime output for `Error`
    instances, no longer crashes when a non-`Error` is thrown

Both swaps are strict-mode adjustments — runtime behaviour is identical
for every input the original handled correctly. They were introduced
because oracle-runtime's tsconfig has `strict: true` and
`noUncheckedIndexedAccess: true`, while apps/app's tsconfig is laxer.

The known scaling concerns (sequential cron, no max-concurrent guard,
ref-counted concurrency that stops working past the cache TTL, etc.) are
**out of scope** here — they're tracked in
`specs/matrix-storage-architecture-review.md` as a separate ticket.

### base-env-config.ts — ConfigService-shaped fallback for the checkpointer

The original `apps/app/src/config.ts` exports a `getConfig()` helper that
returns either the NestJS-injected `ConfigService` or a singleton built
from `process.env`, validated against the Zod schema. The checkpointer
needs that helper because its singleton is constructed inside a Nest
useFactory before request-time DI is available — and it needs three keys:
`SQLITE_DATABASE_PATH`, `ORACLE_ENTITY_DID`, and `ORACLE_DID` (the latter
derived from `MATRIX_ORACLE_ADMIN_USER_ID` via `normalizeDid`).

`packages/oracle-runtime/src/config/base-env-config.ts` mirrors that
helper without depending on apps/app:

- Same `get` / `getOrThrow` shape so the checkpointer's call sites are
  unchanged (`config.getOrThrow('ORACLE_DID')` etc.)
- Same singleton-build path: `baseEnvSchema.safeParse(process.env)` →
  `ConfigService` instance
- `normalizeDid` helper inlined verbatim from
  `apps/app/src/utils/header.utils.ts:47-57` so `ORACLE_DID` is computed
  at singleton construction with no extra wiring

`resetBaseEnvConfigForTesting()` is exported for test isolation but not
re-exported from `src/index.ts`.

### env var name discrepancy: spec says BOT, code says ADMIN

Spec §17.1 lists `MATRIX_BOT_USER_ID` / `MATRIX_BOT_PASSWORD` while
today's `apps/app/src/config.ts` uses `MATRIX_ORACLE_ADMIN_USER_ID` /
`MATRIX_ORACLE_ADMIN_PASSWORD` / `MATRIX_ORACLE_ADMIN_ACCESS_TOKEN`. Per
the task's "extract Tier-0 env vars from today's `apps/app/src/config.ts`"
direction, the relocated schema preserves the **actual current names** —
matrix oracle admin keys, plus the `ACCESS_TOKEN` variant which the spec
list omits but the code requires. Renaming would force every deployed
oracle to update its `.env`. If a rename is desired, it should land as a
focused follow-up with a migration shim, not as part of this relocation.

## Tier-0 env vars in `base-env-schema.ts` (24 keys)

Runtime: `NODE_ENV`, `PORT`, `ORACLE_NAME`, `CORS_ORIGIN`, `NETWORK`.
Matrix: `MATRIX_BASE_URL`, `MATRIX_RECOVERY_PHRASE`, `MATRIX_STORE_PATH`,
`MATRIX_ORACLE_ADMIN_USER_ID`, `MATRIX_ORACLE_ADMIN_PASSWORD`,
`MATRIX_ORACLE_ADMIN_ACCESS_TOKEN`, `MATRIX_ACCOUNT_ROOM_ID`,
`MATRIX_VALUE_PIN`.
Storage: `SQLITE_DATABASE_PATH`.
Chain: `BLOCKSYNC_GRAPHQL_URL`, `ORACLE_ENTITY_DID`, `ORACLE_SECRETS`,
`SECP_MNEMONIC`, `RPC_URL`.
LLM: `LLM_PROVIDER`, `OPENAI_API_KEY`, `OPEN_ROUTER_API_KEY`,
`NEBIUS_API_KEY`, `LIVE_AGENT_AUTH_API_KEY`.

Plugin-owned (NOT in the base schema): `COMPOSIO_API_KEY`,
`COMPOSIO_BASE_URL`, `LANGFUSE_*`, `SLACK_*`, `MEMORY_MCP_URL`,
`MEMORY_ENGINE_URL`, `FIRECRAWL_MCP_URL`, `DOMAIN_INDEXER_URL`,
`SANDBOX_MCP_URL`, `SKILLS_CAPSULES_BASE_URL`,
`SKIP_LOGGING_CHAT_HISTORY_TO_MATRIX`, `DISABLE_CREDITS`,
`SUBSCRIPTION_URL`, `SUBSCRIPTION_ORACLE_MCP_URL`, `REDIS_URL`,
`BLOCKSYNC_URI` (only `BLOCKSYNC_GRAPHQL_URL` is Tier-0 — the unprefixed
one is plugin/optional).

A test in `base-env-schema.test.ts` enumerates the plugin-owned keys and
asserts they are not declared in the base schema, so future drift surfaces
on the test runner.

## Internal exports

`packages/oracle-runtime/src/modules/index.ts` exports:
- `SubscriptionModule` (NestJS `@Module`)
- `SubscriptionMiddleware` (the class)
- `SUBSCRIPTION_UCAN_PORT`, `SUBSCRIPTION_CREDIT_SINK` (DI symbols)
- `SubscriptionUcanPort`, `SubscriptionCreditSink` (port interfaces)
- `ThrottlerModule` (the runtime's wrapper around `@nestjs/throttler`)

Nothing from this task is added to `src/index.ts` — these all wire into
`RuntimeAppModule` via internal-only imports per the relocation contract.

## Out of scope (per task)

- Wiring into `RuntimeAppModule` itself — that's a separate task.
- Subscription middleware migration to the credits plugin — separate.
- Matrix storage scaling fixes — see `specs/matrix-storage-architecture-review.md`.
- Removing plugin-owned env vars from `apps/app/src/config.ts` — happens
  when apps/app/src/ is replaced.

# Matrix and checkpointer

How the runtime persists state. Matrix is both the transport layer (for the `matrix` client surface) and the storage layer (the checkpointer is Matrix-backed SQLite). Not pluggable.

Source: `packages/oracle-runtime/src/matrix/`, `modules/secrets/`, `modules/ucan/`.

## The two roles Matrix plays

1. **Transport.** When a user talks to the oracle through the Matrix client, Matrix is the protocol. The runtime sets `session.client = 'matrix'` and routes messages via the Matrix bot. Plugins access `ctx.matrix.{postToRoom, getRoomState, getEventById}`.

2. **Storage.** Per-thread LangGraph state checkpoints live in per-user SQLite, which is in turn synced to a per-user Matrix room. The local SQLite file (`SQLITE_DATABASE_PATH`) is the hot path; Matrix is the durable mirror.

## UserMatrixSqliteSyncService

`matrix/checkpointer/user-matrix-sqlite-sync-service.service.ts`.

Per-user SQLite database lifecycle:

- `getUserDatabase(userDid)` — opens (or creates) a SQLite DB for the user. Lazy.
- Syncs the DB file to the user's Matrix room in the background.
- Disposes idle DBs after a timeout.

Used by the default checkpointer factory:

```ts
const checkpointSync = nestApp.get(UserMatrixSqliteSyncService, {
  strict: false,
});
const defaultHooks: MainAgentHooks = checkpointSync
  ? {
      checkpointerForUser: async (userDid: string) => {
        const db = await checkpointSync.getUserDatabase(userDid);
        return SqliteSaver.fromDatabase(db) as unknown as BaseCheckpointSaver;
      },
    }
  : {};
```

`SqliteSaver` (from `@ixo/sqlite-saver`) wraps the SQLite DB as a LangGraph `BaseCheckpointSaver`. LangGraph reads/writes thread state through it.

Two properties keep the per-user DB (and the process's memory) bounded:

- **Checkpoint pruning.** LangGraph writes one checkpoint per super-step and never deletes them. After each `put`, the saver drops checkpoints (and their `writes` rows) beyond the newest 20 per thread (`maxCheckpointsPerThread`, `0` disables). The `messages` table is never pruned — it is the durable transcript.
- **Transcript vs. state.** `getTuple` returns the latest checkpoint's message set, which after summarization is the summary + recent tail. `listThreadMessages(threadId)` reads the full transcript from the `messages` table (every message ever written, oldest first) — this is what `listMessages` serves to clients, with the summarization bookkeeping message filtered out.

The Matrix sync path streams: uploads gzip the DB file through a temp file (only the compressed payload is buffered for upload), and downloads gunzip straight to disk. Neither direction holds the decompressed DB in heap.

The `as unknown as BaseCheckpointSaver` cast is the documented cross-package interop seam: `SqliteSaver` extends `BaseCheckpointSaver` from `@langchain/langgraph-checkpoint`, but the hook's return type pulls from `@langchain/langgraph`. pnpm hoists these into separate type identities even at the same version — structurally identical at runtime, but TypeScript can't see that.

## Key setup (post-Matrix-init)

After `matrixManager.init()` succeeds in the background, `wireSigningAndEncryptionKeys` loads two pieces of secret material from the oracle's Matrix account room:

1. **UCAN signing mnemonic** — via `setupClaimSigningMnemonics(...)` from `@ixo/oracles-chain-client`. Returns a mnemonic if the state event is present and decryptable with the configured PIN. Seats on `UcanService.setSigningMnemonic(mnemonic, signerDid)`.

2. **P-256 user-secrets encryption key** — via `loadEncryptionKey(...)`. Returns a private JWK. Seats on `SecretsService.getInstance().setEncryptionKey(privateJwk)`.

Both keys gate features:

- **No signing mnemonic** → `UcanService.createServiceInvocation` cannot mint downstream invocations. Credits middleware fails. Authenticated requests 401.
- **No encryption key** → `SecretsService` returns nothing from `getValues`. Acceptable degraded mode for plugins that don't depend on user secrets.

Boot continues regardless. Operators see warning logs naming the CLI command to provision (`oracles-cli setup-claim-signing-mnemonics` / `oracles-cli setup-encryption-key`).

## SecretsService

`modules/secrets/secrets.service.ts`.

- Per-room secret index: a Matrix state event lists which secret keys exist.
- Per-room values: JWE-encrypted blobs stored as state events. Decrypted using the seated P-256 private JWK.
- 24h cache (in-memory) of decrypted values.
- Singleton (`SecretsService.getInstance()`) because the encryption key seat has to be global. Plugins consume via `rtCtx.secrets`, not directly.

## UcanService

`modules/ucan/ucan.service.ts`.

- Validates inbound UCAN delegations (signature, expiry, capabilities).
- Mints downstream invocations signed by the seated mnemonic.
- Caches resolved did:web service DIDs.

Exposed to plugins via `rtCtx.ucan.{requireCapability, hasCapability, mintInvocation, resolveServiceDid}`.

## Graceful shutdown

`bootstrap/graceful-shutdown.ts` registers SIGTERM and SIGINT handlers (unless `opts.skipGracefulShutdown`). On signal:

1. Close the Nest app (`nestApp.close()`).
2. Disconnect from Matrix (`matrixManager.disconnect()`).
3. Force-exit if the close hangs past a timeout.

This makes `Ctrl+C` and container stops clean — no half-flushed SQLite writes, no orphaned Matrix sync timers.

## Why the checkpointer is not pluggable

The spec calls this out explicitly (§2.2.2). Three reasons:

1. **The checkpointer is a load-bearing dependency.** Wrong implementation = lost thread continuity, lost messages, lost agent state.
2. **Per-user SQLite + Matrix sync is what enables E2E encryption.** Swapping it would also require redesigning the privacy model.
3. **Pluggability adds surface area for little upside.** Forks that need an alternate storage backend can override via `hooks.checkpointerForUser`, but the framework itself is opinionated.

If a future ticket needs to swap the checkpointer (e.g. for a multi-tenant deployment), the `hooks.checkpointerForUser` override is the seam. The storage scaling work is tracked separately in `specs/matrix-storage-architecture-review.md`.

## Read next

- [Boot sequence](boot-sequence.md) — phase 18 (Matrix background init).
- [Modules](modules.md) — `SecretsModule`, `UcanModule`, `AuthModule`.
- [Runtime context](runtime-context.md) — `rtCtx.matrix`, `rtCtx.secrets`, `rtCtx.ucan` surfaces.

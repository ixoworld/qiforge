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

## Matrix chat surface

`modules/messages/matrix-listener-bridge.ts` is the Matrix ingress AND the greeter:

- **Greet-on-join.** The bridge registers `matrixManager.onBotJoinedRoom` next to `onMessage`. When the bot is freshly added to a room (invites are auto-accepted — `autoJoin: true` in `MatrixManager`), it waits ~1.5s for device lists to settle, resolves DM-vs-group shape via `getRoomInfo`, and sends a deterministic greeting composed by `modules/messages/room-greeting.ts`. The send is not just UX: the outbound encrypt establishes Olm 1:1 sessions with current members and distributes a Megolm group session, which is what makes the user's FIRST message in a fresh encrypted room decryptable. Idempotent per process (`welcomedRooms`); send failures are logged, never retried (a re-invite re-greets).
- **Outbound replies** from both the Matrix-ingress path and the portal replay funnel through `matrix/outbound-reply.ts` (`postAgentReplyToMatrix`). Replies over `MATRIX_MESSAGE_OVERFLOW_CHARS` (2,000) are uploaded as an in-thread `response-<ts>.md` file via `MatrixManager.sendFileMessage` with a short lead-in message; upload failure falls back to posting the full text. User-message replay stays verbatim.
- **`MatrixManager.sendFileMessage`** (in `@ixo/matrix`) posts a standard `m.room.message` / `msgtype: 'm.file'` — encrypted rooms go through `crypto.encryptMedia` with the full envelope, plain rooms use a direct mxc URL. `sendMessage` also accepts `mentions: string[]`, emitted as `m.mentions.user_ids` (intentional mentions → push notifications); the concierge plugin's `escalate_to_support` uses this to notify the entity's support team in its Support room.

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

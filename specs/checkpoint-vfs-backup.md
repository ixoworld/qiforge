# Checkpoint Backups on the User's VFS

Move per-user checkpoint DB backups from Matrix room media to the user's IXO
Virtual Filesystem, using the two-hop UCAN flow. The user's conversation state
lands in storage the user owns and delegated, the 100 MB Matrix upload cap
stops being a constraint (VFS accepts 5 GiB), and the upload path loses its
last full-file heap buffers.

## Decisions (made with the lead)

- **User's namespace, two-hop UCAN** — not the oracle's own namespace. The
  backup is user-owned data in user-owned storage; the oracle holds only an
  attenuated delegation over one subtree.
- **Per-user hard cutover, gated on delegation.** The moment a user's
  delegation is available, their next backup cycle goes to VFS, their Matrix
  copy is redacted, and VFS is their only backup from then on. No dual-write,
  ever. Users without a deposited delegation stay on the existing Matrix path
  untouched until the FE flow reaches them.
- **Matrix media path is deleted at a kill date** (or when delegation coverage
  reaches the lead's threshold) in a follow-up PR.

## Prerequisites

1. **The two-hop UCAN rails already exist** (`UcanService.getServiceDelegation`,
   `createInvocationFromDelegation` with nonce, `mintSelfSignedInvocation`) and
   the bundled VFS plugin already ships a typed `VfsClient` (`plugins/vfs/`)
   with per-request minting, timeouts, 401 re-mint retry and both error-body
   shapes parsed. This spec reuses them; the only additions are streaming
   request/response methods on the client and a `RuntimeContext`-free variant
   of `vfsBearer` (the cron has no request context).
2. **FE deposit flow** (portal): the user signs ONE delegation to the oracle's
   DID — resource `ixo:filesystem/oracle-data/<oracleEntityDid>`, ability
   `*` — and deposits it in the UCAN Store (`POST /api/delegations`).
   `*` on that subtree because backups need `fs/write` (upload, implies read)
   **and** `fs/delete` (user-requested storage deletion; `fs/write` does not
   imply it). The attenuation to `oracle-data/<oracleEntityDid>` is the
   guarantee the oracle never touches the user's other files.
3. Network match: `VFS_BASE_URL`, `UCAN_STORE_URL`, `ORACLE_DID` on the same
   network (all resolve the oracle's `did:ixo` via BlockSync; mismatch = 401).

## The storage seam

New interface in `packages/oracle-runtime/src/matrix/checkpointer/`
(`checkpoint-store.ts`):

```ts
export interface CheckpointBackupStore {
  /** Which store this is, for file_events bookkeeping and logs. */
  readonly kind: 'vfs' | 'matrix';
  /**
   * Upload a gzipped snapshot. Streamed with a known size (Content-Length);
   * `openStream` is a factory because a 401 re-mint retry must re-read the
   * temp file from the start — a consumed stream cannot be replayed.
   */
  upload(params: {
    userDid: string;
    storageKey: string;
    openStream: () => NodeJS.ReadableStream;
    sizeBytes: number;
  }): Promise<{ pointer: string; cid?: string }>;
  /** Fetch the backup as a stream, or null when none exists. */
  download(params: {
    userDid: string;
    storageKey: string;
  }): Promise<{ stream: NodeJS.ReadableStream; cid?: string } | null>;
  /** Permanently remove the backup. */
  delete(params: { userDid: string; storageKey: string }): Promise<boolean>;
  /** Can this store serve this user right now? (VFS: delegation available.) */
  available(userDid: string): Promise<boolean>;
}
```

Two implementations:

- `VfsCheckpointStore` (new) — the subject of this spec.
- `MatrixCheckpointStore` — the existing `matrix-upload-utils` calls moved
  behind the interface, byte-for-byte behavior preserved (including E2E media
  encryption and event redaction).

`UserMatrixSqliteSyncService` keeps its entire ORA-382 lifecycle — snapshot
via `VACUUM INTO`, stream-gzip, size guard, checksum + oversized memos,
`uploaded | unchanged | skipped` statuses, cleanup gating — and resolves the
store per user per operation (selection logic below).

## VfsCheckpointStore mechanics

- **Path:** `oracle-data/<oracleEntityDid>/<storageKey>.db.gz` in the user's
  namespace (the delegated subtree).
- **Auth per call:** `getServiceDelegation(userDid, { resource:
'ixo:filesystem', requiredAbility })` (cached token) →
  `createInvocationFromDelegation` with the minimum ability (`fs/write`
  uploads, `fs/read` downloads, `fs/delete` deletes) — fresh single-use
  invocation every request.
- **Upload:** first write `POST /files?path=` with the file stream; on 409
  (exists) `PUT /files/:id` using the file id from `file_events` — and when
  409 arrives with no stored id (lost `file_events.db`), resolve the id once
  via `GET /tree` on the delegated subtree. Body is
  streamed from the `.gz.tmp` file with explicit `Content-Length` (VFS
  buffers length-less large bodies into memory server-side — always send it).
  Record the returned file id + cid.
- **Download:** `GET /content?path=` streamed straight to the `.tmp` file
  (never buffered), then verify `x-vfs-content-hash`/`x-vfs-cid` against the
  received bytes before the existing gunzip → SQLite-header validation. A
  hash mismatch throws `CheckpointIntegrityError` — transient, so the restore
  is retried later and never replaced by a fresh DB (a mid-stream break would
  otherwise hide under a committed 200).
- **Size guard:** same guard slot as today, limit = 5 GiB (VFS upload cap)
  instead of the Matrix media config lookup.
- **Error map** (from the worker contract): 404 → no backup, and the ONLY
  error that means it (fall through per selection logic); auth failures
  (no/expired/revoked delegation, store unreachable, mint failed) propagate
  as transient — never as "no backup", which would start a fresh DB that
  the next cycle writes over the real one; 401 → mint a fresh invocation,
  retry once, then fail the cycle (retry next cron tick — the request is
  sent with `credentials: 'omit'`, without which a streamed body makes the
  401 unobservable); 403 → terminal, error log naming the delegation
  (revoked/attenuation); 429 → skip this cycle (no Retry-After header — do
  not tight-loop); a content-hash mismatch → `CheckpointIntegrityError`,
  also transient (the store copy is re-fetchable); 400 arrives in two shapes
  (`{error,message,status}` and zod-openapi `{success:false,error:{…}}`) —
  parse both; unmatched routes return plain-text 404.

## Store selection & per-user cutover

`file_events` gains backward-compatible columns (same ALTER pattern as
`content_checksum`): `store TEXT DEFAULT 'matrix'`, `vfs_file_id TEXT`,
`vfs_cid TEXT`.

**Upload cron, per user:**

1. `store === 'vfs'` for this storageKey → VFS only. A VFS failure is a
   skipped cycle (existing statuses), never a silent fall-back to Matrix.
2. Otherwise, `vfsStore.available(userDid)` (delegation exists)?
   - Yes → upload to VFS. On the **first success**: set `store='vfs'`, record
     file id + cid, then redact the Matrix media event (existing
     `deleteMediaFromRoom`; failure to redact is a warn — dangling old blob,
     no data risk). This is the user's cutover moment.
   - No → existing Matrix path, unchanged.

**Download (fresh pod / rehydrate):** `file_events` row says which store. No
row (fresh `file_events.db`): try VFS first (delegation may exist and hold
the newer copy), then Matrix, then no-backup (fresh DB) — reusing the
existing unrecoverable/transient error split. For the first five minutes
after the VFS store is attached, a signing key that has not landed yet means
_pending_, not _absent_: the restore fails transiently instead of skipping
the VFS probe (a cut-over user's Matrix copy is redacted, so skipping it
would read as "no backup"); past that window the oracle simply has no
signing key, and VFS is skipped with an error log so Matrix users restore.

**Delete (`deleteUserStorageFromMatrix` → renamed `deleteUserBackup`):**
delete from the store the row names; clear the row and caches (including
`syncedUsers`, per ORA-382).

## Memory budget

Both directions fully streamed. Upload: zero full-file heap copies (the gz
buffer read AND the Matrix E2E `encryptMedia` copy are gone — VFS encrypts at
rest). Download: streamed to disk, hash-verified, gunzip-streamed (already).
Peak per cycle: pipeline chunk buffers only.

## Env

No worker URLs to configure: like the VFS plugin, the store derives
`VFS_BASE_URL`/`UCAN_STORE_URL` from the base `NETWORK` env (shared
`NETWORK_URLS` map, default devnet). The lane is active whenever the oracle
has a UCAN signing key (`ucan.hasSigningKey()`), and per-user activation is
delegation-gated as above. One rollout kill switch in the base env schema:
`CHECKPOINT_VFS_BACKUP_ENABLED` (`'true' | 'false'`, default `'true'`) —
`false` stops NEW cutovers (users already on `store='vfs'` stay on VFS and
never fall back; a VFS outage then shows as skipped cycles with the local
file kept). Update the `build-an-oracle` env reference +
`docs/architecture/matrix-and-checkpointer.md`.

## Observability

- Log on cutover: `Checkpoint backup for user <did> moved to VFS (<size>,
cid <cid>); Matrix copy redacted`.
- Counters worth a Grafana panel: uploads per store kind, delegation-coverage
  gauge (`vfs`-store rows / total rows), 401-retry and 429-skip counts — these
  drive the kill-date decision.

## Testing

- Unit: `VfsCheckpointStore` against mocked HTTP covering the full error map
  (both 400 shapes, 401-retry-once, 403 terminal, 429 skip, 404 null,
  hash-mismatch → null); store-selection/cutover state machine including
  "VFS user never falls back to Matrix" and "first success redacts Matrix";
  `file_events` column migration on a legacy DB file.
- The ORA-382 service tests extend to the seam (oversized-skip and
  active-user tests run against the selected store).
- Live round-trip in the user-run integration suite; the
  `/ixo-ucan-invocation` probe script smoke-tests delegation pickup + a real
  VFS write pre-deploy.

## Sequencing

1. Runtime lands first (safe: without deposited delegations nothing changes).
2. FE deposit flow ships; coverage gauge starts moving.
3. At the lead's coverage threshold or kill date: follow-up PR deletes
   `MatrixCheckpointStore` + the media-config guard code.

## Out of scope

Agent-facing VFS tools (own spec, `specs/vfs-oracle-integration-plan.md`);
oracle-namespace storage (rejected: sovereignty); dual-write (rejected);
backup encryption beyond VFS at-rest (the Matrix E2E property is replaced by
VFS's encryption + the delegation ACL).

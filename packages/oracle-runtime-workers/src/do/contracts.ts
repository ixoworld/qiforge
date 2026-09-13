import type { BotStatus, EncryptedFileInfo } from '@ixo/matrix-bot-workers-sdk';
import type { AttachmentInput } from '../attachments/types';
import type { RealtimeStatus } from '../realtime/realtime-endpoint';
import type { TierFlushResult, TierStatus } from '../sqlite/do-vfs';
/**
 * Cross-object contracts for the Workers runtime.
 *
 * Topology (one Worker deployment = one oracle):
 *
 *   Worker (Hono shell)  ──HTTP──▶  UserOracleDO   (one per user DID)
 *                                       ▲  ▼ RPC
 *   Matrix homeserver  ◀──/sync──▶  MatrixGatewayDO (one per oracle)
 *
 * - `UserOracleDO` owns the user's SQLite working copy (LangGraph checkpoints,
 *   sessions, transcript), runs the agent turn, and streams SSE back to the
 *   shell. Its durable copy of the SQLite file lives in an `OwnerStore` the
 *   user controls (their Matrix room today, their IXO VFS going forward).
 * - `MatrixGatewayDO` owns the bot identity: the E2EE crypto store, the sync
 *   loop, room→user routing, and media upload/download on behalf of user
 *   objects (it is the only object that can encrypt/decrypt).
 *
 * Everything below is plain data so it survives DO RPC / `fetch` boundaries.
 */

/** Bindings every oracle Worker must declare (see the example `wrangler.jsonc`). */
export interface OracleWorkerEnv {
  USER_ORACLE: DurableObjectNamespace<UserOracleObject>;
  MATRIX_GATEWAY: DurableObjectNamespace<MatrixGatewayObject>;

  // --- identity -----------------------------------------------------------
  ORACLE_NAME: string;
  /** UCAN audience — the DID users address invocations/delegations to. */
  ORACLE_DID: string;
  /** On-chain entity DID of the oracle (identity surfaced to the agent). */
  ORACLE_ENTITY_DID?: string;
  NETWORK?: 'mainnet' | 'testnet' | 'devnet';

  // --- auth ---------------------------------------------------------------
  /** Blocksync GraphQL endpoint used to resolve `did:ixo` verification keys. */
  BLOCKSYNC_GRAPHQL_URL: string;
  UCAN_AUTH_MAX_TTL_SECONDS?: string;

  // --- matrix -------------------------------------------------------------
  MATRIX_BASE_URL: string;
  MATRIX_ORACLE_ADMIN_USER_ID: string;
  /** The bot's password: the gateway logs its own device in with it (and a second, crypto-less device for plugins). */
  MATRIX_ORACLE_ADMIN_PASSWORD: string;
  /** SSSS recovery passphrase — lets a fresh device restore room keys from backup. */
  MATRIX_RECOVERY_PHRASE?: string;
  /** Matrix server name used when composing per-user room aliases. */
  MATRIX_HOMESERVER_NAME?: string;
  /**
   * Outgoing-message pacing for the oracle bot (gateway), passed to
   * `@ixo/matrix-bot-workers-sdk`. Mirror the homeserver's `rc_message`
   * (`per_second` / `burst_count`, infra default 3 / 40);
   * `MATRIX_SEND_CONCURRENCY` caps parallel sends across rooms (SDK default
   * 4). Unset = the SDK defaults.
   */
  MATRIX_SEND_RATE_PER_SECOND?: string;
  MATRIX_SEND_BURST?: string;
  MATRIX_SEND_CONCURRENCY?: string;
  /** Room turns in flight at once in the gateway (each ends in an encrypted reply; default 4). */
  MATRIX_TURN_CONCURRENCY?: string;
  /** Idle recycle of the gateway object after this many sends (default 300; 0 disables). */
  MATRIX_RECYCLE_AFTER_SENDS?: string;
  /** Rooms kept fully built in memory (SDK default 64; idle rooms are released). */
  MATRIX_HOT_ROOMS?: string;
  /** Cap on events replayed per room after a restart (SDK default 0 = unbounded). */
  MATRIX_BACKFILL_MAX_EVENTS?: string;

  // --- storage ------------------------------------------------------------
  /**
   * Where the user-owned SQLite file lives. Default (unset) = `vfs`: the IXO
   * VFS is the system of record, with the Matrix room media checked once as a
   * legacy source and migrated in. `matrix` forces legacy room-media storage
   * (dev/harness environments without a VFS worker).
   */
  OWNER_STORE?: 'matrix' | 'vfs';
  /**
   * Per-object budget of clean 64 KiB chunks the DO VFS keeps in memory
   * (bytes, or `4m`/`4096k`; default 8 MiB, range 1–64 MiB). All user
   * objects of a script share one 128 MB isolate — see `GET /debug/storage`
   * for the hit/miss counters that show what a budget buys.
   */
  CHUNK_CACHE_BYTES?: string;
  /**
   * R2 page tier for the users' working copies (see `sqlite/page-tier.ts`):
   * chunks no turn touched for `TIER_EVICT_AFTER_PERIODS` periods move
   * from DO SQLite ($0.20/GB-month, 10 GB cap per object) into 1 MiB R2
   * segment objects ($0.015/GB-month, no cap) under a per-object prefix.
   * Absent = every chunk stays in DO storage (the pre-tier behaviour).
   */
  TIER_BUCKET?: R2Bucket;
  /** Soft target for hot bytes per user object (bytes or `16m`; default 16 MiB). */
  TIER_HOT_BUDGET_BYTES?: string;
  /** Periods (of `TIER_PERIOD_MS`) a chunk must go untouched before eviction (default 2). */
  TIER_EVICT_AFTER_PERIODS?: string;
  /** Length of one access-tracking period in ms (default one day; tests shorten it). */
  TIER_PERIOD_MS?: string;
  /** IXO VFS worker base URL when `OWNER_STORE=vfs` (defaults per NETWORK). */
  VFS_BASE_URL?: string;
  /** UCAN store worker base URL when `OWNER_STORE=vfs` (defaults per NETWORK). */
  UCAN_STORE_URL?: string;

  // --- ops ----------------------------------------------------------------
  /**
   * Slack incoming-webhook URL for operator alerts (currently: a user's
   * working copy crossing each GB watermark from 1 GB toward the 10 GB DO
   * storage cap). Unset = alerts off.
   */
  SLACK_ALERT_WEBHOOK_URL?: string;
  /**
   * Cloudflare native rate-limit binding, keyed per authenticated user DID
   * (limit/period are set on the binding in `wrangler.jsonc`). Absent in the
   * local harness and vitest pool, where the shell degrades to no limiting.
   */
  RATE_LIMIT?: RateLimit;

  // --- llm ----------------------------------------------------------------
  OPEN_ROUTER_API_KEY: string;
  DEFAULT_MODEL?: string;
  /** Display markup for `GET /models` prices (default 1.6). */
  MODEL_PRICE_MARKUP?: string;
  MAIN_REASONING_EFFORT?: string;
  /** LangGraph steps one turn may take before `GraphRecursionError` (default 600; Node hard-codes 200). */
  TURN_RECURSION_LIMIT?: string;
  /** Platform model provider. Default `openrouter`; `nebius` for self-hosted. */
  LLM_PROVIDER?: 'openrouter' | 'nebius';
  /** Nebius Token Factory API key — required when `LLM_PROVIDER=nebius`. */
  NEBIUS_API_KEY?: string;

  // --- langsmith tracing ---------------------------------------------------
  /** `'true'` traces every turn (explicit tracer — Workers has no env auto-attach). */
  LANGSMITH_TRACING?: string;
  LANGSMITH_API_KEY?: string;
  LANGSMITH_PROJECT?: string;
  /** LangSmith API endpoint override (self-hosted / EU). */
  LANGSMITH_ENDPOINT?: string;
  /**
   * Comma-separated DID allowlist for selective per-user tracing (`*` traces
   * everyone). Requires `LANGSMITH_API_KEY`; ignored when `LANGSMITH_TRACING`
   * is `'true'` (global mode already traces every turn).
   */
  LANGSMITH_TRACED_DIDS?: string;

  // --- byo-llm -------------------------------------------------------------
  /** `'true'` enables bring-your-own-credential LLMs (`/byo-llm/*` surface). */
  BYO_LLM_ENABLED?: string;
  /** ChatGPT-subscription backend override (a transparent proxy off Cloudflare egress). */
  BYO_CHATGPT_BACKEND_URL?: string;
  BYO_CHATGPT_PROXY_AUTH_TOKEN?: string;
  /** Override of the public ChatGPT OAuth client id (Codex CLI client). */
  BYO_CHATGPT_CLIENT_ID?: string;

  // --- secrets -------------------------------------------------------------
  /**
   * The oracle's Matrix *account* room — where the CLI published the P-256
   * encryption key (`ixo.room.encryption_key.index` / `p256_encryption`).
   * Only the gateway (holding the bot session) can read it.
   */
  MATRIX_ACCOUNT_ROOM_ID?: string;
  /** PIN the published private JWK is AES-256-CBC-encrypted with. */
  MATRIX_VALUE_PIN?: string;

  // --- misc ---------------------------------------------------------------
  LOG_LEVEL?: string;
  CORS_ORIGIN?: string;

  /** Plugin-declared env is read through the same object. */
  [key: string]: unknown;
}

/**
 * RPC payload rule: Durable Object RPC types reject `unknown`/deeply nested
 * generic shapes, so anything nested (event content, transcripts, metadata)
 * crosses the boundary as a JSON **string**. Flat records of primitives are
 * passed as objects.
 */
export type JsonString = string;

/** Who is talking and through which transport. */
export interface TurnIdentity {
  /** Validated user DID (from the UCAN signer or the Matrix sender mapping). */
  userDid: string;
  /** `@did-ixo-…:server` when known. */
  matrixUserId?: string;
  /** Raw UCAN delegation CAR forwarded by the client (HTTP turns only). */
  ucanDelegation?: string;
  /** Its expiration (unix seconds) when the shell validated one. */
  ucanDelegationExpiration?: number;
  timezone?: string;
}

/** Request the shell / gateway sends to `UserOracleDO` to run one turn. */
export interface TurnRequest {
  identity: TurnIdentity;
  sessionId: string;
  message: string;
  client: 'portal' | 'matrix';
  /** Matrix room the turn arrived in (Matrix turns) or the user's DM room. */
  roomId?: string;
  /** Thread root when the user replied inside a thread. */
  threadId?: string;
  /** The user's message event this turn answers (Matrix turns): anchors the `work_status` card. */
  eventId?: string;
  requestId: string;
  /** Per-request model override (validated against the catalog). */
  model?: string;
  /** JSON-encoded free-form metadata forwarded by the client. */
  metadata?: JsonString;
  /** Files attached to the message (validated `AttachmentDto` shape). */
  attachments?: AttachmentInput[];
}

/** Non-streaming turn result. */
export interface TurnResult {
  sessionId: string;
  requestId: string;
  /** Final assistant text. */
  text: string;
  /** Id of the final assistant message, when one was produced. */
  messageId?: string;
  /** Tool calls made during the turn (name + summarized status), for logging. */
  toolCalls: Array<{ name: string; status: 'done' | 'error' }>;
  /** The stored reply of a turn that had already finished (a gateway asked again after a reset). */
  replayed?: boolean;
}

/**
 * Prefix of the error a user object raises when a gateway asks again about a
 * room message whose turn the object itself lost mid-run (see
 * `src/do/matrix-turn-ledger.ts`): not re-run, the user is told to retry.
 */
export const TURN_INTERRUPTED_MARKER =
  'turn interrupted by a runtime reset before it finished; not re-run';

export function isInterruptedTurnError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(TURN_INTERRUPTED_MARKER);
}

/** Row shape served by `GET /sessions`. */
export interface SessionSummary {
  sessionId: string;
  title?: string;
  createdAt: string;
  lastUpdatedAt: string;
  roomId?: string;
}

/** `search_memory_engine`'s raw upstream schema + whether it converts to Zod. */
export interface MemorySchemaSnapshot {
  tool: string;
  toolCount: number;
  rawSchema: string;
  convertible: boolean;
  capturedAt: string;
}

/** `GET /debug/memory-schema` payload. */
export type MemorySchemaDebug = MemorySchemaSnapshot | { error: string };

/** `GET /debug/storage`: the user object's working-copy and owner-store state. */
export interface StorageStatus {
  /**
   * Raw upstream schema of the memory engine's `search_memory_engine` tool
   * as this isolate last received it, plus whether it converts to Zod —
   * evidence for "did the model see the enum" questions. Present only after
   * a memory turn ran in this isolate.
   */
  memorySchemaDump?: MemorySchemaSnapshot | null;
  /** Random per in-memory instance; changes whenever the platform unloaded and re-created the object. */
  instanceId: string;
  /** Milliseconds since this instance was constructed. */
  instanceUptimeMs: number;
  fileBytes: number;
  pages: number;
  ownerEtag?: string;
  lastFlushAt?: number;
  dirty: boolean;
  flushInFlight: boolean;
  /** VFS write generation now vs. at the last successful upload. */
  writeGeneration?: number;
  uploadedGeneration?: number;
  lastChecksum?: string;
  flushFailures: number;
  lastVacuumAt?: number;
  /** True once the user's legacy Matrix copy has been removed or found absent. */
  legacyCleared?: boolean;
  /** Background session-history indexing runs in progress (keeps the object resident). */
  indexingInFlight?: number;
  /** Turns currently running in this object (streaming or not). */
  activeTurns?: number;
  /** Live JavaScript timers (debug routes only) — any keeps the object resident. */
  pendingTimers?: number;
  lastAccessAt?: number;
  alarmAt: number | null;
  pageCount?: number;
  freelistCount?: number;
  /** SQLite's own page cache (`PRAGMA cache_size`; negative = KiB). */
  sqliteCacheSize?: number;
  /** The R2 page tier of this object's working copy (see sqlite/page-tier.ts). */
  tier?: TierStatus & { lastPassAt?: number };
  /** The DO VFS clean-chunk cache and its storage counters (isolate lifetime). */
  chunkCache?: {
    budgetBytes: number;
    capacityChunks: number;
    cachedBytes: number;
    hits: number;
    misses: number;
    storageReads: number;
    rowsRead: number;
    storageWrites: number;
    rowsWritten: number;
  };
}

/**
 * RPC surface of `UserOracleDO` (methods callable on the stub). HTTP-shaped
 * calls (streaming turns) go through `fetch()` instead so the SSE body can be
 * piped straight to the client.
 */
export interface UserOracleObject extends Rpc.DurableObjectBranded {
  /** Run a turn and return the final text (used by the Matrix gateway). */
  runTurn(req: TurnRequest): Promise<TurnResult>;
  createSession(
    identity: TurnIdentity,
    opts?: { roomId?: string; sessionId?: string },
  ): Promise<SessionSummary>;
  listSessions(
    identity: TurnIdentity,
    opts?: { limit?: number; offset?: number },
  ): Promise<{ sessions: SessionSummary[]; total: number }>;
  deleteSession(identity: TurnIdentity, sessionId: string): Promise<boolean>;
  /** JSON-encoded `MessageDto[]` for `GET /messages/:sessionId`. */
  listMessages(identity: TurnIdentity, sessionId: string): Promise<JsonString>;
  abortTurn(sessionId: string): Promise<boolean>;
  /** Adopt a freshly deposited delegation for header-less turns (no boot). */
  setDelegation(
    userDid: string,
    raw: string,
    expiration?: number,
  ): Promise<void>;
  /** Forget the cached delegation at once (revocation). */
  clearDelegation(userDid: string): Promise<void>;
  /**
   * Close the Matrix `work_status` card of a turn once its reply has been
   * posted (or the turn ended without one). No-op for unregistered turns.
   */
  finishWorkStatus(
    requestId: string,
    phase: 'done' | 'superseded',
  ): Promise<void>;
  /** Operator probe: what header-less turns would mint from. */
  delegationStatus(userDid: string): Promise<{
    present: boolean;
    expiration?: number;
    source: 'memory' | 'storage' | 'none';
  }>;
  /** Force an owner-copy export now (tests / admin). */
  flushToOwnerStore(): Promise<{
    uploaded: boolean;
    bytes: number;
    etag?: string;
    /** Why nothing was sent: no write since the last upload, or same bytes. */
    skipped?: 'unchanged-generation' | 'unchanged-checksum';
    /** The upload went to legacy Matrix media after repeated VFS failures. */
    fallback?: 'matrix';
  }>;
  /**
   * Drop the working copy (pages + caches) so the next access re-imports from
   * the owner store. Simulates eviction/loss of the DO cache in tests and is
   * the "user deleted their file upstream" path.
   */
  resetWorkingCopy(): Promise<{ reloadedFromOwnerStore: boolean }>;
  /** Run one R2 page-tier eviction pass now (debug routes; `force` ignores recency). */
  tierFlush(opts?: {
    force?: boolean;
    maxSegments?: number;
  }): Promise<TierFlushResult>;
  /** Raw upstream schema of the memory search tool as fetched right now. */
  debugMemorySchema(userDid: string): Promise<MemorySchemaDebug>;
  /** Forcibly reset the object like a platform host drain (debug routes only). The call itself rejects. */
  debugAbortObject(): Promise<void>;
  /** Forget when the last re-authorise prompt was posted (debug routes only). */
  debugResetReauthThrottle(): Promise<void>;
  /** Raw session row for `GET /debug/sessions/:id` (null when unknown). */
  debugSession(
    userDid: string,
    sessionId: string,
  ): Promise<Record<string, unknown> | null>;
  /** Diagnostics: file size, page count, owner-store state, cache counters. */
  storageStatus(): Promise<StorageStatus>;
  /** Realtime (socket.io) channel: attached sockets and pending browser calls. */
  realtimeStatus(): Promise<RealtimeStatus>;
  /**
   * Diagnostics: the object's current alarm and the user's task records — the
   * pair that answers "is this task going to fire, and when?".
   */
  /** Task records, open runs and the alarm; boots the object when cold (`userDid` = the caller). */
  tasksStatus(userDid?: string): Promise<{
    now: number;
    alarm: number | null;
    schedulerActive: boolean;
    tasks: Array<{
      id: string;
      title: string;
      status: string;
      nextRunAt: string | null;
      lastResult: { ok: boolean; summary: string; at: string } | null;
      consecutiveFailures: number;
      deliveryRoomId: string | null;
    }>;
    /** Runs no incarnation has finished: what an alarm will re-deliver or close. */
    openRuns: Array<{
      runId: string;
      taskId: string;
      startedAt: string;
      state: 'running' | 'delivering';
      attempts: number;
      retryAt: number | null;
    }>;
  }>;
}

/** A private room the bot creates and owns (dedicated `[Task]` rooms). */
export interface CreateRoomOptions {
  name: string;
  topic?: string;
  /** Matrix ids to invite (the user, typically). */
  invite: string[];
  /** The user this room belongs to: replies in it route to their object. */
  userDid: string;
}

/**
 * RPC surface of `MatrixGatewayDO`. User objects call it for anything that
 * needs the bot identity (sending, media, room lookups); the shell calls
 * `ensureStarted()` on boot/health so the sync loop is running. The
 * lifecycle, send and state members are the bot SDK's (`MatrixBotDO`); the
 * rest is the oracle's.
 */
export interface MatrixGatewayObject extends Rpc.DurableObjectBranded {
  /**
   * A media event's content as a stream, AS STORED: in an E2EE room the
   * ciphertext plus the `EncryptedFile` fields to pipe through the SDK's
   * `createAttachmentDecryptor` on the caller's side (a stream that errors
   * on the far side of an RPC only surfaces here as a disconnect, so the
   * hash check belongs to the consumer). Null when unknown or redacted.
   */
  downloadEventMediaStream(
    roomId: string,
    eventId: string,
  ): Promise<MediaStream | null>;
  /** Authenticated media download of an `mxc://` URI, as a stream. */
  downloadMxcMediaStream(mxc: string): Promise<ReadableStream<Uint8Array>>;
  /** Forcibly reset the gateway object like a platform host drain (debug routes only). The call itself rejects. */
  debugAbortObject(): Promise<void>;
  /** Stop the bot (operator/debug; `ensureStarted`/cron brings it back). */
  stop(): Promise<void>;
  /** Idempotent — starts the bot + keep-alive alarm if not running. */
  ensureStarted(): Promise<{
    started: boolean;
    userId: string;
    deviceId: string;
  }>;
  /**
   * Stop the bot and start it again from its persisted state — the same
   * device, the same keys. Operators after a bad state; the matrix tests.
   */
  restart(): Promise<{ started: boolean; userId: string; deviceId: string }>;
  /**
   * Log the bot in as a NEW device (one-time-key conflict recovery) and retire
   * the old one; resolves once the new device serves.
   */
  rotateDevice(
    reason?: string,
  ): Promise<{ started: boolean; userId: string; deviceId: string }>;
  /** Durable outbox rows (no bodies), oldest first. */
  listOutbox(): Promise<OutboxRow[]>;
  /**
   * Credentials of the oracle's second, crypto-less device for plugins that
   * run their own Matrix client (editor, flows). Logged in once with the
   * account password, kept in the gateway's storage, re-logged in with the
   * same device id if the homeserver ever rejects the token.
   */
  botCredentials(): Promise<BotCredentials>;
  status(): Promise<GatewayStatus>;
  /** Send a text message (encrypted when the room is). Returns the event id. */
  sendText(
    roomId: string,
    body: string,
    opts?: {
      threadId?: string;
      formattedBody?: string;
      /**
       * `interactive` (default: markers, replies, notices) is dispatched
       * ahead of `background` (HTTP-turn room replays).
       */
      priority?: 'interactive' | 'background';
      /**
       * Persist in the gateway's outbox until acknowledged and re-issue
       * after a restart (default true). `false` for the session marker,
       * whose event id the caller consumes synchronously.
       */
      durable?: boolean;
      /** Caller-pinned transaction id (idempotent retries across restarts). */
      txnId?: string;
    },
  ): Promise<string>;
  /**
   * Send an arbitrary timeline event (`content` JSON-encoded). Returns the
   * event id. `txnId` pins the transaction id, as for `sendText`: the
   * homeserver deduplicates by it per device, so a send retried after a lost
   * response returns the original event instead of posting a second one.
   */
  sendEvent(
    roomId: string,
    type: string,
    content: JsonString,
    opts?: { txnId?: string },
  ): Promise<string>;
  /** Resolve the canonical user↔oracle room for a user DID (alias lookup, cached). */
  resolveUserRoom(
    userDid: string,
  ): Promise<{ roomId: string; alias: string } | null>;
  /** Create a private bot-owned room (dedicated `[Task]` rooms) and invite users. */
  createDedicatedRoom(opts: CreateRoomOptions): Promise<{ roomId: string }>;
  /**
   * Upload a user's SQLite snapshot as room media (`m.ixo.media_upload` +
   * `m.ixo.media_state[storageKey]`), encrypting when the room is E2EE.
   * Returns the new event id. Wire-compatible with the Node runtime so
   * existing users migrate transparently.
   */
  uploadUserSnapshotStream(
    userDid: string,
    storageKey: string,
    /** The gzipped file; encrypted chunk by chunk in an E2EE room, never buffered. */
    body: ReadableStream<Uint8Array>,
    filename: string,
    /** Exact byte length of `body` (the homeserver needs a Content-Length). */
    size: number,
  ): Promise<{ eventId: string }>;
  /**
   * The latest snapshot for `storageKey` as a stream, as stored (see
   * `downloadEventMediaStream`), or null when none exists.
   */
  downloadUserSnapshotStream(
    userDid: string,
    storageKey: string,
  ): Promise<SnapshotStream | null>;
  /** Read a room state event's content, JSON-encoded (state is never E2EE). Null when absent. */
  getRoomStateEvent(
    roomId: string,
    type: string,
    stateKey?: string,
  ): Promise<JsonString | null>;
  /** Write a room state event (`content` JSON-encoded). Returns the event id. */
  sendStateEvent(
    roomId: string,
    type: string,
    content: JsonString,
    stateKey?: string,
  ): Promise<string>;
  /** Full room state as a JSON-encoded array of `{ type, state_key, content, sender, event_id }`. */
  getRoomState(roomId: string): Promise<JsonString>;
  /** One timeline event (decrypted when E2EE) as JSON `{ event_id, type, content, sender, origin_server_ts }`, or null. */
  getEvent(roomId: string, eventId: string): Promise<JsonString | null>;
  /**
   * The oracle's P-256 secrets key, JSON-encoded private JWK. Read from the
   * oracle's Matrix *account* room (`MATRIX_ACCOUNT_ROOM_ID`) — the published
   * `ixo.room.encryption_key.index` state names the timeline event carrying
   * the PIN-encrypted private key, decrypted here with `MATRIX_VALUE_PIN`.
   * Null when the key is not provisioned or the env vars are unset. User
   * objects fetch it once at boot and seat it into their secrets service.
   */
  getOracleSecretsKey(): Promise<JsonString | null>;
  /**
   * The oracle's Ed25519 UCAN signing mnemonic, read the way the Node
   * runtime stores it: the account room's `ixo.room.state.secure` /
   * `encrypted_mnemonic_ed_signing` state event, whose `encrypted_mnemonic`
   * is AES-256-CBC encrypted with `MATRIX_VALUE_PIN`. Read-only (the Node
   * runtime provisions it). Null when the env vars are unset, the event is
   * missing or the PIN does not decrypt it — each logged, never thrown.
   * User objects call this at boot when `ORACLE_SIGNING_MNEMONIC` is unset.
   */
  getOracleSigningMnemonic(): Promise<string | null>;
}

export interface BotCredentials {
  baseUrl: string;
  userId: string;
  accessToken: string;
  deviceId: string;
}

export interface OutboxRow {
  txnId: string;
  roomId: string;
  kind: 'text' | 'notice';
  threadId?: string;
  bodyChars: number;
  htmlChars: number;
  attempts: number;
  enqueuedAt: number;
}

/** `MatrixBotDO.status()` plus the gateway's own turn bookkeeping. */
/**
 * Media handed across the Durable Object boundary as a stream, as stored on
 * the homeserver: `file` is present when the event carried an encrypted
 * attachment — pipe `stream` through the SDK's `createAttachmentDecryptor`
 * with it; without `file` the stream is the plain upload. `size` is the
 * sender's `info.size` when it set one.
 */
export interface MediaStream {
  stream: ReadableStream<Uint8Array>;
  file?: EncryptedFileInfo;
  size?: number;
  mimetype?: string;
  filename?: string;
}

/** `MediaStream` of a user's snapshot, plus the media event that carries it. */
export interface SnapshotStream extends MediaStream {
  eventId: string;
}

export interface GatewayStatus extends BotStatus {
  turns: { inFlight: number; waiting: number };
  /** Debounce buffers waiting to become turns. */
  ingestPending: number;
  /** Room messages whose turn has not ended yet (durable; replayed after a reset). */
  inbox: number;
}

/** Derive the durable-object name for a user's object. */
export function userObjectName(userDid: string, oracleDid: string): string {
  return `${oracleDid}::${userDid}`;
}

/** Storage key for a user's checkpoint snapshot — identical to the Node runtime. */
export async function checkpointStorageKey(
  userDid: string,
  oracleDid: string,
): Promise<string> {
  const data = new TextEncoder().encode(`checkpoint_${userDid}_${oracleDid}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 17);
}

/** `did:ixo:ixo1abc` → `did-ixo-ixo1abc` (room-alias form, same as the Node runtime). */
export function didToAliasPart(did: string): string {
  return did.replace(/:/g, '-');
}

/** Canonical user↔oracle room alias local part: `<user>_<oracle>`. */
export function userOracleRoomAlias(
  userDid: string,
  oracleDid: string,
  serverName: string,
): string {
  return `#${didToAliasPart(userDid)}_${didToAliasPart(oracleDid)}:${serverName}`;
}

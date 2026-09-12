/* eslint-disable no-console -- console IS the logger on Workers (Logs/observability). */
/**
 * `UserOracleDO` — one Durable Object per (user DID, oracle).
 *
 * Owns, for exactly one user:
 *   - the SQLite **working copy** (LangGraph checkpoints, transcript,
 *     sessions) as 4 KB pages in this object's storage, opened through
 *     wa-sqlite — bounded by DO storage (10 GB), not isolate memory;
 *   - the **owner copy** sync: on first access the file is imported from the
 *     user's `OwnerStore` (their Matrix room today, their IXO VFS when
 *     `OWNER_STORE=vfs`); after every turn a debounced alarm exports it back.
 *     The object is a cache — the user's file is the truth;
 *   - the **agent turn** itself: `createMainAgent` from the runtime core with
 *     this user's checkpointer, streamed as SSE straight from the object.
 *
 * A Durable Object is single-threaded, which replaces the Node runtime's
 * per-user ref-counting, busy timeouts and cron locks outright.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import {
  applyAttachmentRetention,
  ATTACHMENT_PAYLOAD_TURNS,
  ATTACHMENT_PLACEHOLDER_PREFIX,
  attachmentMetas,
  attachmentRef,
  INLINE_PAYLOAD_NEEDLE,
  isAttachmentViewMessage,
  offloadInlinePayloads,
  parseAttachmentInputs,
  prepareAttachments,
  viewAttachment,
  type AttachmentViewSurface,
  type MatrixMediaSource,
  type SandboxUploadConfig,
  MAX_FILE_SIZE,
  readBytesCapped,
} from '../attachments';
import type { RuntimeCore } from '../core';
import {
  createLlmAdapter,
  getDefaultModelId,
  getModelCapabilities,
  isAllowedModel,
  langsmithEnvFromWorkerEnv,
  llmEnvFromWorkerEnv,
  resolveLangsmithTracing,
  type OpenRouterLlmAdapter,
} from '../core/llm';
import { createMainAgent } from '../core/main-agent';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AmbientServices, LlmAdapter } from '../core/runtime-context';
import { chatGptBackendFromEnv } from '../llm/byo-client';
import { createByoLlmAdapter } from '../llm/byo-adapter';
import { isByoModelId } from '../llm/byo-catalog';
import { handleByoRequest } from '../llm/byo-routes';
import {
  WorkersByoService,
  type ByoStateStore,
  type ByoTurnState,
} from '../llm/byo-service';
import { buildByoFallbackNotice } from '../llm/provider-error';
import { parseJwk } from '../secrets/jwe';
import { WorkersSecretsService } from '../secrets/secrets-service';
import { createSecretsAdapter } from './secrets-adapter';
import {
  metadataBuildState,
  metadataGraphInput,
  parseTurnMetadata,
  priorMetadataState,
} from './turn-metadata';
import {
  RealtimeEndpoint,
  type RealtimeStatus,
} from '../realtime/realtime-endpoint';
import { authenticate } from '../shell/auth';
import {
  compactStep,
  finishCompaction,
  type CompactCursors,
} from '../sqlite/blob-compactor';
import { createHash } from 'node:crypto';
import {
  cachePagesForBytes,
  parseChunkCacheBytes,
} from '../sqlite/cache-config';
import { DoSqliteDatabase } from '../sqlite/database';
import {
  shouldVacuum,
  vacuumWanted,
  VACUUM_IDLE_MS,
} from '../sqlite/vacuum-policy';
import { SqliteSaver } from '../sqlite/sqlite-saver';
import {
  crossedGbThreshold,
  postSlackAlert,
  storageAlertText,
} from './size-alerts';
import {
  SessionsStore,
  UNTITLED_SESSION,
  type SessionRecord,
} from '../sqlite/sessions-store';
import { createAttachmentDecryptor } from '@ixo/matrix-bot-workers-sdk';
import { MatrixMediaOwnerStore } from '../owner-store/matrix-media-store';
import { MigratingOwnerStore } from '../owner-store/migrating-store';
import type { OwnerCopy } from '../owner-store/types';
import {
  isRetryableOwnerCopyError,
  OWNER_COPY_LOAD_RETRY_DELAYS_MS,
  OwnerCopyUnavailableError,
  parseOwnerCopyFailure,
  toRpcError,
} from '../owner-store/owner-copy-errors';
import { withRetry } from '../owner-store/retry';
import {
  installTimerTracker,
  pendingTimers,
  timerTrackerInstalled,
} from './debug-timers';
import {
  IxoVfsOwnerStore,
  VFS_DEFAULT_BASE_URLS,
} from '../owner-store/ixo-vfs-store';
import type { OwnerStore } from '../owner-store/types';
import { createAmbientServices, SessionEventRouter } from './ambient';
import {
  checkpointStorageKey,
  type MatrixGatewayObject,
  type OracleWorkerEnv,
  type SessionSummary,
  type StorageStatus,
  type TurnIdentity,
  type TurnRequest,
  type TurnResult,
  type MemorySchemaDebug,
  TURN_INTERRUPTED_MARKER,
} from './contracts';
import { turnRecursionLimit } from './turn-config';
import { decideMatrixTurn, MatrixTurnLedger } from './matrix-turn-ledger';
import { decideBootDirty } from './boot-dirty';
import { mirrorTxnId, RoomMirror } from './room-mirror';
import { ReauthPrompter } from './reauth-prompt';
import {
  createTaskScheduler,
  TASK_SESSION_PREFIX,
  type TaskScheduler,
} from '../tasks/scheduler';
import { decodeRoomStateContent } from '../matrix/room-state-codec';
import { freshStub } from './fresh-stub';
import { WorkStatusProducer } from '../matrix/work-status';
import { fetchUserMatrixServerName } from '../matrix/user-homeserver';
import { createWorkStatusMiddleware } from '../core/middlewares/work-status';
import { UserPreferencesStore } from '../plugins/user-preferences/user-preferences-store';
import {
  SessionHistoryIndexer,
  type HistoryMessage,
  type IndexableSession,
} from '../memory/session-history-indexer';
import { createSseTurnStream, formatSSE, SSE_HEADERS } from './sse-stream';
import { parseTurnBody, type TurnBody } from './turn-body';
import { formatReplay } from '../matrix/replay-format';
import { retryGateway } from './gateway-retry';
import {
  fetchMemorySchemaDump,
  getMemorySchemaDump,
} from '../plugins/memory/memory-tools';
import {
  contentToText,
  isSummarizationMessage,
  transformTranscript,
} from './transcript';
import { WorkersUcanService } from './ucan-service';

const DB_FILE = 'oracle.db';
/**
 * Owner-store flush debounce after a write: hourly. A flush streams the
 * working copy to the user's VFS (constant memory, see `flushToOwnerStore`)
 * and is skipped outright when nothing was written since the last upload,
 * so the cost of a tick is small — but every upload is still a full-file
 * transfer, and the Node runtime uploads on a cron of similar order. The
 * idle path flushes before any eviction, so nothing waits longer than this
 * plus one retry window.
 */
const FLUSH_DEBOUNCE_MS = 24 * 60 * 60_000;
/** A failed flush is retried this soon (not at the next daily tick). */
const FLUSH_RETRY_DELAY_MS = 10 * 60_000;
/** From this many consecutive failed flushes on, the failure is logged at error level. */
const FLUSH_FAILURES_ERROR_THRESHOLD = 3;
/**
 * Idle time after which the working copy is dropped from Durable Object
 * storage (rebuilt from the VFS copy on the next touch). Five days: a
 * wipe + re-import costs about as much as keeping the file for ~5 days
 * (see the README's "Object lifetime and cost"), so wiping sooner costs
 * more for anyone who comes back within that window.
 */
const IDLE_EVICT_MS = 5 * 24 * 60 * 60 * 1000;
/** Set once the legacy Matrix copy has been removed (or found absent): no more lookups. */
const META_LEGACY_CLEARED = 'meta:legacyCleared';
const META_USER_DID = 'meta:userDid';
/** VFS write generation of the file at the last successful upload (see `DoVfs.writeGeneration`). */
const META_UPLOADED_GEN = 'meta:uploadedGen';
/**
 * The next housekeeping deadline (flush, tasks, compaction, vacuum, idle
 * eviction) the alarm was armed for. Lets a wake that is only due for a
 * realtime heartbeat round skip booting the database.
 */
const META_HOUSEKEEPING_AT = 'meta:housekeepingAt';
const META_MATRIX_USER_ID = 'meta:matrixUserId';
/** A fallback-built Matrix id (homeserver not resolvable) is retried after this long. */
const MATRIX_USER_ID_FALLBACK_TTL_MS = 60 * 60_000;

interface MatrixUserIdCache {
  userDid: string;
  matrixUserId: string;
  /** True when the homeserver came from the DID document (never re-resolved). */
  resolved: boolean;
  at: number;
}
/** Consecutive flush failures (cleared on success). */
const META_FLUSH_FAILURES = 'meta:flushFailures';
const META_LAST_VACUUM = 'meta:lastVacuumAt';
/**
 * Persisted twin of the in-memory `dirty` flag. The flag alone dies with an
 * eviction, and evictions are routine — without the marker an alarm waking a
 * cold object would see "nothing to flush" and the user's owner copy would go
 * silently stale.
 */
const META_DIRTY = 'meta:dirty';
const META_OWNER_ETAG = 'meta:ownerEtag';
const META_LAST_FLUSH = 'meta:lastFlushAt';
const META_LAST_CHECKSUM = 'meta:lastChecksum';
const META_LAST_ACCESS = 'meta:lastAccessAt';
/**
 * The user's most recent delegation to this oracle, cached so header-less
 * turns (Matrix ingress, tasks, clients that authenticate with the
 * invocation alone) can still mint downstream invocations. The durable
 * source is the `ucan_delegation` room state the client deposits via
 * `POST /delegation` — the same place the Node runtime reads it from.
 */
const META_DELEGATION = 'meta:delegation';
/** How long a "no deposited delegation" verdict is trusted before re-checking the room. */
const DELEGATION_MISS_TTL_MS = 60_000;
const META_REAUTH_PROMPT_AT = 'meta:reauthPromptAt';
/** Node's `AgentBuilder.DEFAULT_REAUTH_THROTTLE_SECONDS`. */
const DEFAULT_REAUTH_THROTTLE_SECONDS = 6 * 60 * 60;

/** `UCAN_REAUTH_PROMPT_THROTTLE_SECONDS` as a positive number, else the default. */
function reauthThrottleSeconds(env: OracleWorkerEnv): number {
  const raw = env.UCAN_REAUTH_PROMPT_THROTTLE_SECONDS;
  return typeof raw === 'string' &&
    Number.isFinite(Number(raw)) &&
    Number(raw) > 0
    ? Number(raw)
    : DEFAULT_REAUTH_THROTTLE_SECONDS;
}
/** Highest whole-GB size watermark already alerted to Slack (0 = none). */
const META_SIZE_ALERT_GB = 'meta:sizeAlertGb';
/** Blob re-compression bookkeeping (see sqlite/blob-compactor.ts). */
const META_COMPACT_DONE = 'meta:compactDone';
const META_COMPACT_CURSORS = 'meta:compactCursors';
const META_COMPACT_SAVED = 'meta:compactSavedBytes';
/** Rows examined per compaction alarm tick. */
const COMPACT_BATCH = 300;
const NEW_CONVERSATION_TEXT = 'New Conversation Started';
/** Node's `SYNTHETIC_SESSION_PREFIX`: background-task sessions, no Matrix root event. */
const SYNTHETIC_SESSION_PREFIX = '$task-';

/**
 * Host hooks for the per-turn agent build — the Workers form of the Node
 * runtime's `opts.hooks.getRoomTitle` / `opts.hooks.safetyModel`. Both are
 * resolved per turn against the user object's ambient services (a Worker has
 * no process-wide model instance or Matrix client to capture at module
 * scope). Absent hooks leave the corresponding middleware uninstalled, as on
 * Node.
 */
export interface OracleWorkerHooks {
  /**
   * Page title for the page-context middleware (`state.editorRoomId`).
   * Return `undefined` when unknown; the block then shows the bare room id.
   */
  getRoomTitle?: (
    roomId: string,
    ambient: AmbientServices,
  ) => Promise<string | undefined>;
  /** Cheap classification model for the safety-guardrail middleware. */
  safetyModel?: (ambient: AmbientServices) => BaseChatModel;
}

export interface UserOracleDOOptions {
  core: (env: OracleWorkerEnv) => RuntimeCore;
  hooks?: OracleWorkerHooks;
}

interface StoredDelegation {
  raw: string;
  /** UCAN expiration (seconds) when known — deposits carry it, headers don't. */
  expiration?: number;
  at: number;
}

interface FlushResult {
  uploaded: boolean;
  /** Raw file size (skips) or bytes sent upstream (uploads). */
  bytes: number;
  etag?: string;
  skipped?: 'unchanged-generation' | 'unchanged-checksum';
  /** True when this flush also removed the user's legacy Matrix copy. */
  legacyRemoved?: boolean;
}

/** Hex SHA-256 of a byte stream, hashed as it flows. */
async function sha256OfStream(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const hash = createHash('sha256');
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
    }
  } finally {
    reader.releaseLock();
  }
  return hash.digest('hex');
}

/** Does this adapter expose provider config + role resolution (platform adapters do)? */
function isProviderAdapter(llm: LlmAdapter): llm is OpenRouterLlmAdapter {
  return 'providerConfig' in llm && 'modelForRole' in llm;
}

/**
 * The object could not boot for this user: answer with the owner-copy code
 * (403 no grant / rejected credentials, 503 transient store failure) or a
 * plain 500 for anything else. Same mapping as the shell's `onError`.
 */
function readyFailureResponse(err: unknown): Response {
  const failure = parseOwnerCopyFailure(err);
  if (failure) {
    return Response.json(
      {
        statusCode: failure.httpStatus,
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
      },
      { status: failure.httpStatus },
    );
  }
  return Response.json(
    {
      statusCode: 500,
      message: err instanceof Error ? err.message : String(err),
    },
    { status: 500 },
  );
}

function toSummary(row: SessionRecord): SessionSummary {
  return {
    sessionId: row.sessionId,
    title: row.title,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
    roomId: row.roomId,
  };
}

function lastAiText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.type === 'ai') return contentToText(m.content);
  }
  return '';
}

/** Id of the final assistant message (what `POST /messages` reports as `message.id`). */
function lastAiMessageId(messages: BaseMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.type === 'ai' && typeof m.id === 'string' && m.id.length > 0)
      return m.id;
  }
  return undefined;
}

export function createUserOracleDO(opts: UserOracleDOOptions) {
  return class UserOracleDO extends DurableObject<OracleWorkerEnv> {
    private db: DoSqliteDatabase | null = null;
    private saver: SqliteSaver | null = null;
    private sessions: SessionsStore | null = null;
    private ownerStore: OwnerStore | null = null;
    private ambient: AmbientServices | null = null;
    private ucan: WorkersUcanService | null = null;
    private secretsService: WorkersSecretsService | null = null;
    private byo: WorkersByoService | null = null;
    private userDid: string | null = null;
    private readonly events = new SessionEventRouter();
    /** socket.io endpoint (built on first use; restores hibernated sockets). */
    private realtimeEndpoint: RealtimeEndpoint | null = null;

    constructor(ctx: DurableObjectState, env: OracleWorkerEnv) {
      super(ctx, env);
      this.adoptHibernatedSockets();
    }

    /**
     * Woken with hibernated sockets attached: build the realtime endpoint
     * NOW so it re-adopts them and taps the event router before any turn
     * runs. Left lazy, a turn arriving on a fresh instance (nothing touched
     * the realtime surface yet) would emit into an untapped router and the
     * still-connected browser would see none of its events. Called from the
     * constructor and again from `ready()` — the per-request boot every RPC
     * goes through — because the hibernated sockets are only guaranteed to
     * be listed once a request is being handled.
     */
    private adoptHibernatedSockets(): void {
      if (this.realtimeEndpoint) return;
      if (this.ctx.getWebSockets().length > 0) this.realtime.nextPingAt();
    }
    private readonly aborts = new Map<string, AbortController>();
    private readonly delegations = new Map<string, { raw: string }>();
    /** Epoch-ms until which a room-state delegation lookup is not retried. */
    private delegationMissUntil = 0;
    private dirty = false;
    /** The flush in progress, if any (single-flight; a VFS snapshot is open while it runs). */
    private flushInFlight: Promise<FlushResult> | null = null;

    /** Identifies this in-memory instance: a new id means the platform unloaded the object in between. */
    private readonly instanceId = crypto.randomUUID();

    private readonly bootedAt = Date.now();
    /** Memoised `META_COMPACT_DONE` (null = not yet read from storage). */
    private compactDone: boolean | null = null;
    private compactCursors: CompactCursors | null = null;
    /** Memoised `META_SIZE_ALERT_GB` (null = not yet read from storage). */
    private sizeAlertGb: number | null = null;
    private taskScheduler: TaskScheduler | null = null;

    /** Per-room user preferences (room state, Node-compatible envelope). */
    private preferences: UserPreferencesStore | null = null;

    /** Matrix `work_status` liveness cards, one per in-flight Matrix turn. */
    private workStatus: WorkStatusProducer | null = null;

    /** In-flight Matrix turn per session (sessionId → requestId), for supersede. */
    private readonly matrixTurns = new Map<string, string>();
    /** What this object remembers about each room message it answered (see matrix-turn-ledger.ts). */
    private matrixLedger: MatrixTurnLedger | null = null;
    /** Room mirrors of HTTP turns, serialised per session and retried across gateway restarts (see room-mirror.ts). */
    private mirror: RoomMirror | null = null;
    /** The oracle room of each session this instance resolved: spares the mirrors a row read per send. */
    private readonly sessionRooms = new Map<string, string>();
    /** The throttled `delegation_required` prompt (see reauth-prompt.ts). */
    private reauthPrompter: ReauthPrompter | null = null;
    /** Room turns running right now, by Matrix event id: a gateway that asks again attaches instead of re-running. */
    private readonly matrixTurnRuns = new Map<string, Promise<TurnResult>>();

    /** Session-history → memory-engine indexing (built lazily, see `scheduleHistoryIndexing`). */
    private historyIndexer: SessionHistoryIndexer | null = null;

    /**
     * Transcripts captured BEFORE a session is deleted, keyed by session id:
     * the indexer runs after the RPC returned, when the rows are gone.
     */
    private readonly historySnapshots = new Map<
      string,
      { session: IndexableSession; messages: HistoryMessage[] }
    >();
    private initPromise: Promise<void> | null = null;
    private reloadedFromOwnerStore = false;
    /** Set by `adoptOwnerCopy` for a legacy copy: `ready()` flushes it to the system of record right after. */
    private pendingLegacyMigration: { bytes: number } | null = null;

    // ── lifecycle ───────────────────────────────────────────────────────────

    private get core(): RuntimeCore {
      return opts.core(this.env);
    }

    /**
     * The user's Matrix id for a turn that did not come through Matrix (HTTP,
     * socket, alarm): `@did-ixo-<address>:<their homeserver>`, the way the
     * Node runtime's `didToMatrixUserId(did, homeServerName)` builds it. The
     * homeserver is the DID document's MatrixHomeServer service (Blocksync),
     * falling back to this oracle's own server; the answer is cached in the
     * object's storage because a DID's homeserver does not change. Room
     * membership checks (the editor) and task invites depend on this being
     * right, so an unresolvable id is `undefined`, never a guess.
     */
    private async resolveMatrixUserId(
      userDid: string,
    ): Promise<string | undefined> {
      if (!userDid.startsWith('did:ixo:')) return undefined;
      const cached =
        await this.ctx.storage.get<MatrixUserIdCache>(META_MATRIX_USER_ID);
      if (
        cached &&
        cached.userDid === userDid &&
        (cached.resolved ||
          Date.now() - cached.at < MATRIX_USER_ID_FALLBACK_TTL_MS)
      ) {
        return cached.matrixUserId;
      }
      let server: string | undefined;
      let resolved = false;
      const blocksync = this.env.BLOCKSYNC_GRAPHQL_URL;
      if (blocksync) {
        try {
          const fromDid = await fetchUserMatrixServerName(blocksync, userDid);
          if (fromDid) {
            server = fromDid;
            resolved = true;
          }
        } catch (err) {
          console.warn(
            `[user-do] could not resolve the Matrix homeserver of ${userDid} — using this oracle's: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      server ??=
        typeof this.env.MATRIX_HOMESERVER_NAME === 'string'
          ? this.env.MATRIX_HOMESERVER_NAME
          : undefined;
      if (!server) return undefined;
      const matrixUserId = `@${userDid.replace(/:/g, '-')}:${server}`;
      await this.ctx.storage.put<MatrixUserIdCache>(META_MATRIX_USER_ID, {
        userDid,
        matrixUserId,
        resolved,
        at: Date.now(),
      });
      return matrixUserId;
    }

    /**
     * The oracle's gateway. A self-refreshing handle (see `fresh-stub.ts`):
     * helpers that keep it for the object's lifetime (owner store,
     * preferences, ambient adapter) keep working across gateway restarts.
     */
    private get gateway(): DurableObjectStub<MatrixGatewayObject> {
      return freshStub(() =>
        this.env.MATRIX_GATEWAY.get(
          this.env.MATRIX_GATEWAY.idFromName(this.env.ORACLE_DID),
        ),
      );
    }

    /** Idempotent boot: bind user, open SQLite (importing the owner copy on a cold object). */
    private async ready(identity: TurnIdentity): Promise<void> {
      this.installDebugTimerTracker();
      this.adoptHibernatedSockets();
      let delegationReplaced = false;
      if (identity.ucanDelegation) {
        // Clients (the Portal's SDK) send their cached delegation with every
        // request; a token this object has not seen is a re-authorization.
        const known =
          this.delegations.get(identity.userDid)?.raw ??
          (await this.ctx.storage.get<StoredDelegation>(META_DELEGATION))?.raw;
        delegationReplaced = known !== identity.ucanDelegation;
        this.delegations.set(identity.userDid, {
          raw: identity.ucanDelegation,
        });
        // Remember it for turns that arrive without the header.
        void this.ctx.storage.put(META_DELEGATION, {
          raw: identity.ucanDelegation,
          at: Date.now(),
          ...(typeof identity.ucanDelegationExpiration === 'number'
            ? { expiration: identity.ucanDelegationExpiration }
            : {}),
        } satisfies StoredDelegation);
      } else if (!this.delegations.has(identity.userDid)) {
        await this.hydrateDelegation(identity.userDid);
      }
      if (!this.initPromise) {
        this.initPromise = this.boot(identity.userDid).catch((err) => {
          this.initPromise = null;
          throw err;
        });
      }
      await this.initPromise;
      if (this.userDid && this.userDid !== identity.userDid) {
        throw new Error(
          `UserOracleDO bound to ${this.userDid} received a request for ${identity.userDid}`,
        );
      }
      await this.ctx.storage.put(META_LAST_ACCESS, Date.now());
      if (delegationReplaced) await this.onDelegationReplaced();
    }

    /**
     * The mnemonic the oracle signs downstream UCAN invocations with:
     * `ORACLE_SIGNING_MNEMONIC` when set, otherwise the one the Node runtime
     * keeps in the Matrix account room (read and decrypted by the gateway,
     * memoised there). Undefined leaves the object without a signing key —
     * plugins that need one degrade with their usual "no signing key" result
     * — and never fails the boot.
     */
    private async resolveSigningMnemonic(): Promise<string | undefined> {
      const fromEnv = this.env.ORACLE_SIGNING_MNEMONIC;
      if (typeof fromEnv === 'string' && fromEnv.trim().length > 0)
        return fromEnv;
      try {
        const fromRoom = await this.gateway.getOracleSigningMnemonic();
        if (fromRoom) return fromRoom;
      } catch (err) {
        console.warn(
          `[user-do] signing mnemonic unavailable from the account room: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      console.warn(
        '[user-do] no UCAN signing key: ORACLE_SIGNING_MNEMONIC is unset and the account room holds no readable mnemonic — downstream minting is off',
      );
      return undefined;
    }

    /**
     * The object holds a delegation it had not seen before (a header on this
     * request, or a deposit through the shell). A fresh delegation is the one
     * thing that turns a "no file-storage grant" flush failure into a
     * success: forget the failure streak and, with unsaved turns, flush now
     * instead of at the next 10-minute retry.
     */
    private async onDelegationReplaced(): Promise<void> {
      await this.ctx.storage.delete(META_FLUSH_FAILURES);
      if (!this.db) return;
      if (
        !this.dirty &&
        (await this.ctx.storage.get<boolean>(META_DIRTY)) === true
      )
        this.dirty = true;
      if (this.dirty) void this.flushToOwnerStore().catch(() => undefined);
    }

    /**
     * Populate the in-memory delegation for a turn that carried none: first
     * this object's cache, then the `ucan_delegation` room state the client
     * deposited. Nothing found → plugins degrade exactly as before (no
     * downstream auth), re-checked after `DELEGATION_MISS_TTL_MS`.
     */
    private async hydrateDelegation(userDid: string): Promise<void> {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const live = (
        d: StoredDelegation | null | undefined,
      ): d is StoredDelegation =>
        Boolean(d?.raw) &&
        (typeof d?.expiration !== 'number' || d.expiration > nowSeconds);
      const cached =
        await this.ctx.storage.get<StoredDelegation>(META_DELEGATION);
      if (live(cached)) {
        this.delegations.set(userDid, { raw: cached.raw });
        return;
      }
      if (Date.now() < this.delegationMissUntil) return;
      try {
        const room = await this.gateway.resolveUserRoom(userDid);
        const json = room
          ? await this.gateway.getRoomStateEvent(
              room.roomId,
              'ixo.room.state',
              'ucan_delegation',
            )
          : null;
        // Node writes this key through its compressed room-state codec;
        // earlier builds of this runtime wrote plain JSON. Read both.
        const state = json
          ? ((await decodeRoomStateContent(JSON.parse(json) as unknown)) as {
              raw?: string;
              expiration?: number;
            } | null)
          : null;
        const deposited: StoredDelegation | null = state?.raw
          ? {
              raw: state.raw,
              at: Date.now(),
              ...(typeof state.expiration === 'number'
                ? { expiration: state.expiration }
                : {}),
            }
          : null;
        if (live(deposited)) {
          this.delegations.set(userDid, { raw: deposited.raw });
          await this.ctx.storage.put(META_DELEGATION, deposited);
          console.log(
            `[user-do] delegation for ${userDid} loaded from the deposited room state (header-less turn)`,
          );
          return;
        }
      } catch (err) {
        console.warn(
          `[user-do] could not load ${userDid}'s deposited delegation: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.delegationMissUntil = Date.now() + DELEGATION_MISS_TTL_MS;
    }

    private async boot(userDid: string): Promise<void> {
      const stored = await this.ctx.storage.get<string>(META_USER_DID);
      if (stored && stored !== userDid)
        throw new Error(`Object bound to ${stored}, not ${userDid}`);
      if (!stored) await this.ctx.storage.put(META_USER_DID, userDid);
      this.userDid = userDid;

      const env = this.env;
      // The gateway lazily starts on first use; make sure it is up before the
      // signing mnemonic, the owner store or room lookups need it (idempotent,
      // cheap once running).
      await this.gateway.ensureStarted().catch((err) => {
        console.warn(
          `[user-do] matrix gateway not available yet: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      this.ucan = new WorkersUcanService({
        oracleDid: env.ORACLE_DID,
        signingMnemonic: await this.resolveSigningMnemonic(),
        logger: console,
      });
      this.ownerStore = await this.createOwnerStore(userDid);

      // Per-room JWE secrets: seat the oracle's P-256 key (fetched once from
      // the gateway, which reads the Matrix account room). Without a key the
      // service still lists the index; values/writes degrade as on Node.
      const secretsService = new WorkersSecretsService({
        gateway: this.gateway,
        logger: console,
      });
      this.secretsService = secretsService;
      try {
        const keyJson = await this.gateway.getOracleSecretsKey();
        if (keyJson) {
          const jwk = parseJwk(keyJson);
          if (jwk) secretsService.setEncryptionKey(jwk);
          else
            console.error(
              '[user-do] oracle secrets key is not a valid JWK — secrets stay unavailable',
            );
        }
      } catch (err) {
        console.warn(
          `[user-do] oracle secrets key unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Bring-your-own-credential LLMs (gated by BYO_LLM_ENABLED). The
      // service lives here because this object is single-threaded per user —
      // refresh single-flight, credential epochs and pending rotated tokens
      // need exactly that.
      this.byo = new WorkersByoService({
        enabled: env.BYO_LLM_ENABLED === 'true',
        chatGptClientId:
          typeof env.BYO_CHATGPT_CLIENT_ID === 'string' &&
          env.BYO_CHATGPT_CLIENT_ID.length > 0
            ? env.BYO_CHATGPT_CLIENT_ID
            : undefined,
        secrets: secretsService,
        resolveRoomId: async (did) => {
          try {
            return (await this.gateway.resolveUserRoom(did))?.roomId ?? null;
          } catch (err) {
            console.warn(
              `[user-do] could not resolve oracle room for ${did}: ${err instanceof Error ? err.message : String(err)}`,
            );
            return null;
          }
        },
        store: createByoStateStore(this.ctx.storage),
        logger: console,
        chatGptBackend: chatGptBackendFromEnv(env),
      });

      const db = await DoSqliteDatabase.open(
        this.ctx,
        DB_FILE,
        this.sqliteOpenOptions(),
      );
      // Cold object (no pages yet) → pull the user's file if they have one.
      // `null` means the owner store PROVABLY holds no file (a new user): an
      // empty working copy is right. A load that FAILS is different: there is
      // no local copy to fall back on, and starting empty would hide the
      // user's history and — once a turn dirtied it — get flushed over the
      // real copy. So the request fails instead; the boot is not memoised on
      // failure, and the next request simply retries the load.
      if (db.fileSize === 0) {
        const store = this.ownerStore;
        let loaded: OwnerCopy | null;
        let attempts = 0;
        try {
          loaded = await withRetry(
            () => {
              attempts += 1;
              return store.load();
            },
            {
              delaysMs: OWNER_COPY_LOAD_RETRY_DELAYS_MS,
              isRetryable: isRetryableOwnerCopyError,
              onRetry: (err, attempt, delayMs) =>
                console.warn(
                  `[user-do] owner copy load for ${userDid} failed (attempt ${attempt}) — retrying in ${delayMs} ms: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                ),
            },
          );
        } catch (err) {
          const failure = new OwnerCopyUnavailableError(userDid, err, attempts);
          console.error(
            `[user-do] owner copy load failed for ${userDid} (${failure.code}, ${attempts} attempt(s)) — refusing to start an empty working copy: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          throw toRpcError(failure);
        }
        if (loaded) {
          const imported = await this.adoptOwnerCopy(db, loaded);
          this.reloadedFromOwnerStore = true;
          console.log(
            `[user-do] imported ${imported} bytes from ${loaded.fromLegacy ? 'legacy Matrix media' : this.ownerStore.kind} for ${userDid}`,
          );
        }
      } else {
        // Warm object: notice if the user replaced or deleted their file
        // upstream. A `head()` that FAILS (a VFS error/timeout, or our own
        // delete→move replace window where the real path momentarily does
        // not exist) must NEVER be read as "the file is gone" — swallowing
        // the error to null and wiping the working copy on it would destroy
        // the durable local history over a transient blip. So distinguish a
        // proven absence (null) from an unknown (the call threw).
        const knownEtag = await this.ctx.storage.get<string>(META_OWNER_ETAG);
        let head: { etag: string } | null | undefined;
        try {
          head = await this.ownerStore.head();
        } catch (err) {
          head = undefined; // unknown — leave the working copy untouched
          console.warn(
            `[user-do] could not check the owner copy for ${userDid} (keeping the working copy): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        if (head === null && knownEtag) {
          // Proven gone upstream. The durable working copy is the live source
          // of truth: only DROP it when there is nothing to lose — a
          // zero-turn file. A working copy that holds turns is KEPT and
          // re-flushed, re-establishing the owner copy; a genuine "forget me"
          // goes through the explicit `remove()` path, never through an
          // auto-wipe that could fire on a mid-replace crash or a stale list.
          if ((await this.localTurnCount(db)) === 0) {
            console.warn(
              `[user-do] owner copy for ${userDid} is gone upstream and the working copy is empty — dropping it`,
            );
            await this.wipeWorkingCopy(db);
            this.db = await DoSqliteDatabase.open(
              this.ctx,
              DB_FILE,
              this.sqliteOpenOptions(),
            );
          } else {
            console.warn(
              `[user-do] owner copy for ${userDid} is gone upstream but the working copy holds turns — keeping it and re-uploading on the next flush`,
            );
            this.markDirty();
          }
        } else if (head && knownEtag && head.etag !== knownEtag) {
          const loaded = await this.ownerStore.load().catch(() => null);
          if (loaded) {
            await this.adoptOwnerCopy(db, loaded);
            this.reloadedFromOwnerStore = true;
            console.log(
              `[user-do] owner copy changed upstream (${knownEtag} → ${head.etag}); re-imported`,
            );
          }
        } else if (head && !knownEtag) {
          // This object first booted before the user's owner file became
          // readable — e.g. a migrating Node oracle uploaded its final
          // checkpoint AFTER this object's first touch, or that first load
          // failed. The owner file is the system of record: adopt it while
          // nothing has been chatted here (a client may have created an
          // empty session, but no turn ever ran → no checkpoints); once local
          // turns exist neither side can win automatically, so keep local
          // and say so loudly (operators resolve via /debug/storage/reset).
          const localTurns = await this.localTurnCount(db);
          if (localTurns === 0) {
            const loaded = await this.ownerStore.load().catch((err) => {
              console.warn(
                `[user-do] late owner copy load failed for ${userDid}: ${err instanceof Error ? err.message : String(err)}`,
              );
              return null;
            });
            if (loaded) {
              const imported = await this.adoptOwnerCopy(db, loaded);
              this.reloadedFromOwnerStore = true;
              console.log(
                `[user-do] owner copy appeared upstream after first boot; imported ${imported} bytes from ${this.ownerStore.kind} for ${userDid}`,
              );
            }
          } else {
            console.warn(
              `[user-do] owner copy exists upstream (${head.etag}) but was never imported and ${localTurns} local checkpoint(s) already exist for ${userDid} — keeping the local copy`,
            );
          }
        }
      }
      // A working copy that never held a single turn cannot be the user's
      // history — even when it was just imported from the system of record.
      // The system of record CAN legitimately hold a zero-turn file: a client
      // (the Portal) that created a session but never chatted flushes an empty
      // DB to VFS, which then shadows the user's real Node-runtime history in
      // Matrix media. So this runs regardless of `reloadedFromOwnerStore`: if
      // the working copy has zero turns and a legacy (Matrix) copy WITH turns
      // exists, adopt it and flush it over the empty file. Guard on the legacy
      // copy actually having turns so a genuinely new user (empty everywhere)
      // is left empty, not churned.
      const activeDb = this.db ?? db;
      if (
        this.ownerStore.loadLegacy &&
        (await this.localTurnCount(activeDb)) === 0
      ) {
        const legacy = await this.ownerStore.loadLegacy();
        if (legacy) {
          // Trial import: only the checkpoint count tells us whether the
          // legacy copy holds history, so keep the (tiny, zero-turn) working
          // copy to put back if it does not.
          const before = await activeDb.export();
          const adoptedBytes = await activeDb.importFromStream(legacy.stream);
          const adoptedTurns = await this.localTurnCount(activeDb);
          if (adoptedTurns > 0) {
            // The adopted bytes are NOT what the system of record holds:
            // forget the last upload so the flush below actually sends them.
            await this.ctx.storage.delete([
              META_LAST_CHECKSUM,
              META_UPLOADED_GEN,
            ]);
            this.reloadedFromOwnerStore = true;
            // Flush the adopted history over the empty file in the system of
            // record so the next cold boot imports it directly.
            this.markDirty();
            console.log(
              `[user-do] working copy had no turns; adopted the legacy Matrix copy (${adoptedBytes} bytes, ${adoptedTurns} checkpoint(s)) for ${userDid} — flushing it to the system of record`,
            );
          } else {
            await activeDb.import(before);
            console.log(
              `[user-do] legacy Matrix copy for ${userDid} holds no turns either; working copy left as is`,
            );
          }
        }
      }

      this.db ??= db;
      const liveDb = this.db;
      if (this.pendingLegacyMigration) {
        const { bytes } = this.pendingLegacyMigration;
        this.pendingLegacyMigration = null;
        // Second half of the one-time migration: the legacy copy just
        // imported goes to the system of record from the working copy —
        // streamed from a snapshot like every flush, so a Node-era history of
        // any size costs a few chunks of memory. A failure (no
        // `ixo:filesystem` delegation yet, a VFS outage) keeps the copy dirty
        // and retried every 10 min; the object serves the legacy history
        // meanwhile, and the Matrix copy is only redacted once VFS holds it.
        try {
          const flushed = await this.flushToOwnerStore();
          console.log(
            `[user-do] migrated ${bytes} bytes from legacy Matrix media to ${this.ownerStore.kind} for ${userDid} (${flushed.etag ?? '-'})`,
          );
        } catch (err) {
          console.warn(
            `[user-do] VFS migration write failed for ${userDid} — serving the legacy Matrix copy for now: ${err instanceof Error ? err.message : String(err)}`,
          );
          // Sooner than the 24 h debounce `markDirty` armed: the system of
          // record is still empty for this user.
          this.requestAlarm(Date.now() + FLUSH_RETRY_DELAY_MS);
        }
      }
      await this.reconcileDirtyOnBoot(liveDb, userDid);
      {
        // One line per boot so an operator can tell what a user's object
        // actually holds without a debug route: which store, how big, how
        // many turns/sessions, and which upstream version it tracks.
        const sessionRow = await liveDb
          .get<{ n: number }>('SELECT count(*) AS n FROM sessions')
          .catch(() => undefined);
        // An already-migrated user (VFS holds the file, Matrix still has the
        // old copy): remove the legacy copy — but ONLY once the VFS copy
        // PROVABLY holds this working copy's exact bytes
        // (`ownerCopyIsCurrent` re-hashes and compares to the last upload),
        // never merely because a VFS file with the right etag exists.
        // Redacting on etag alone would drop the last backstop while the VFS
        // copy could still be a smaller or older export. A dirty or
        // not-yet-verified copy waits: the flush that lands it does the
        // removal itself.
        if (
          (await this.localTurnCount(liveDb)) > 0 &&
          (await this.ownerCopyIsCurrent(liveDb))
        ) {
          const ownerEtag = await this.ctx.storage.get<string>(META_OWNER_ETAG);
          if (ownerEtag) await this.removeLegacyCopyIfAny(ownerEtag);
        }
        console.log(
          `[user-do] ready ${userDid}: store=${this.ownerStore.kind} legacy=${this.ownerStore.loadLegacy ? 'yes' : 'no'} file=${liveDb.fileSize}B turns=${await this.localTurnCount(liveDb)} sessions=${sessionRow?.n ?? 0} ownerEtag=${(await this.ctx.storage.get<string>(META_OWNER_ETAG)) ?? '-'} reloaded=${this.reloadedFromOwnerStore}`,
        );
      }
      this.saver = new SqliteSaver(liveDb, undefined, {
        oracleName: this.core.identity.name,
      });
      await this.saver.setup();
      this.sessions = new SessionsStore(liveDb);
      await this.sessions.setup();
      this.matrixLedger = new MatrixTurnLedger(liveDb);
      await this.matrixLedger.setup();

      const core = this.core;
      // Boot-time plugin hooks + collision checks, once per object (memoised).
      await core.warm();

      const maxTasks = Number(core.validatedEnv.TASKS_MAX_PER_USER);
      const minCron = Number(core.validatedEnv.TASKS_MIN_CRON_INTERVAL_SEC);
      this.taskScheduler = await createTaskScheduler({
        db: liveDb,
        userDid,
        oracleDid: env.ORACLE_DID,
        oracleName: core.identity.name,
        matrixUserId: await this.resolveMatrixUserId(userDid),
        gateway: this.gateway,
        runTurn: (req) => this.runTurn(req),
        requestAlarm: (at) => this.requestAlarm(at),
        log: console,
        ...(Number.isFinite(maxTasks) ? { maxTasksPerUser: maxTasks } : {}),
        ...(Number.isFinite(minCron) ? { minCronIntervalSec: minCron } : {}),
      });
      if (this.taskScheduler) {
        const next = await this.taskScheduler.nextWakeAt().catch(() => null);
        if (next !== null) this.requestAlarm(Math.max(next, Date.now() + 1000));
      }

      // Resume (or start) legacy-blob compaction in the background: files
      // imported from the Node runtime arrive with uncompressed blobs.
      this.compactDone ??=
        (await this.ctx.storage.get<boolean>(META_COMPACT_DONE)) ?? false;
      if (!this.compactDone) this.requestAlarm(Date.now() + 3000);

      // Provider selection: `core.llm` is the OpenRouter adapter built from
      // the validated base env; `LLM_PROVIDER=nebius` (read from the raw
      // Worker env — it is not part of the base schema) swaps in the Nebius
      // adapter for this object's ambient services.
      const llm: LlmAdapter =
        env.LLM_PROVIDER === 'nebius'
          ? createLlmAdapter(llmEnvFromWorkerEnv(env), console)
          : core.llm;

      this.preferences = new UserPreferencesStore(this.gateway, {
        logger: console,
      });
      this.workStatus = new WorkStatusProducer({
        postEvent: (roomId, type, content) =>
          this.gateway.sendEvent(roomId, type, JSON.stringify(content)),
        logger: console,
      });
      this.ambient = createAmbientServices({
        ...(this.taskScheduler ? { tasks: this.taskScheduler.surface } : {}),
        preferences: this.preferences,
        frontend: this.realtime.frontend,
        config: core.validatedEnv,
        identity: core.identity,
        availablePlugins: core.availablePlugins,
        llm,
        logger: console,
        storage: this.ctx.storage,
        gateway: this.gateway,
        ucan: this.ucan,
        delegationFor: (did) => this.delegations.get(did),
        events: this.events,
        secrets: createSecretsAdapter(secretsService),
        background: (work) => this.ctx.waitUntil(work),
      });
    }

    /**
     * IXO VFS is the system of record for the user's file. The Matrix room
     * media copy is a read-only LEGACY source: consulted only when VFS has no
     * file yet (users coming from the Node runtime), migrated into VFS on
     * first touch, never written again. `OWNER_STORE=matrix` remains as an
     * explicit legacy/dev override (e.g. environments with no VFS worker).
     */
    private async createOwnerStore(userDid: string): Promise<OwnerStore> {
      const env = this.env;
      const storageKey = await checkpointStorageKey(userDid, env.ORACLE_DID);
      const matrixStore = new MatrixMediaOwnerStore({
        gateway: this.gateway,
        userDid,
        storageKey,
      });
      if (env.OWNER_STORE === 'matrix') return matrixStore;

      const network = env.NETWORK ?? 'devnet';
      if (!this.ucan) throw new Error('ucan service not initialised');
      const vfsStore = new IxoVfsOwnerStore({
        ucan: this.ucan,
        userDid,
        oracleDid: env.ORACLE_DID,
        vfsBaseUrl:
          env.VFS_BASE_URL ??
          VFS_DEFAULT_BASE_URLS[network] ??
          VFS_DEFAULT_BASE_URLS.devnet!,
        // The user's one delegation to this oracle — hydrated by `ready()`
        // before boot, replaced at once by `setDelegation` / `clearDelegation`.
        delegation: () => this.delegations.get(userDid)?.raw,
      });
      return new MigratingOwnerStore({
        primary: vfsStore,
        legacy: matrixStore,
      });
    }

    /** Drop the working copy entirely; the caller reopens/reboots afterwards. */
    private async wipeWorkingCopy(db: DoSqliteDatabase | null): Promise<void> {
      if (db) {
        await db.close().catch(() => undefined);
      }
      await DoSqliteDatabase.wipe(this.ctx, DB_FILE);
      await this.ctx.storage.delete([
        META_OWNER_ETAG,
        META_LAST_CHECKSUM,
        META_LAST_FLUSH,
        META_UPLOADED_GEN,
        META_FLUSH_FAILURES,
        META_LAST_VACUUM,
      ]);
    }

    /** `CHUNK_CACHE_BYTES` → the VFS clean-chunk budget for this object. */
    private sqliteOpenOptions(): { cachePages: number } {
      const bytes = parseChunkCacheBytes(this.env.CHUNK_CACHE_BYTES, (m) =>
        console.warn(`[user-do] ${m}`),
      );
      return { cachePages: cachePagesForBytes(bytes) };
    }

    /**
     * Stream an owner copy into the working copy and record what it is:
     * upstream etag, its checksum, and the VFS generation that now matches
     * the upstream file (so the next flush knows there is nothing to send
     * until a turn writes). Returns the byte length imported.
     */
    private async adoptOwnerCopy(
      db: DoSqliteDatabase,
      copy: OwnerCopy,
    ): Promise<number> {
      const bytes = await db.importFromStream(copy.stream);
      await this.ctx.storage.put(META_OWNER_ETAG, copy.etag);
      if (copy.fromLegacy) {
        // Streamed in from the legacy Matrix media, not in the system of
        // record yet: forget any earlier upload markers so the flush that
        // `ready()` runs next (`pendingLegacyMigration`) actually sends it,
        // and forget "no legacy copy, stop looking" — a copy evidently
        // exists now, and the flush must be able to redact it.
        await this.ctx.storage.delete([
          META_LAST_CHECKSUM,
          META_UPLOADED_GEN,
          META_LEGACY_CLEARED,
        ]);
        this.markDirty();
        this.pendingLegacyMigration = { bytes };
        return bytes;
      }
      await this.ctx.storage.put(META_LAST_CHECKSUM, await db.checksum());
      await this.ctx.storage.put(META_UPLOADED_GEN, db.writeGeneration);
      return bytes;
    }

    /**
     * Whether the upstream copy provably holds the working copy's content:
     * nothing was written since the last successful upload AND the file
     * still hashes to what was uploaded. A working copy that never ran a
     * turn holds nothing worth keeping either way.
     */
    private async ownerCopyIsCurrent(db: DoSqliteDatabase): Promise<boolean> {
      if (this.dirty) return false;
      const uploadedGen = await this.ctx.storage.get<number>(META_UPLOADED_GEN);
      const lastChecksum =
        await this.ctx.storage.get<string>(META_LAST_CHECKSUM);
      if (lastChecksum === undefined)
        return (await this.localTurnCount(db)) === 0;
      // Objects that last flushed before generations were recorded verify
      // by hash alone; everyone else gets the cheap generation gate first.
      if (uploadedGen !== undefined && uploadedGen !== db.writeGeneration)
        return false;
      return (await db.checksum()) === lastChecksum;
    }

    /** Checkpoint rows in the working copy — zero means no turn ever ran here. */
    private async localTurnCount(db: DoSqliteDatabase): Promise<number> {
      const row = await db
        .get<{ n: number }>('SELECT count(*) AS n FROM checkpoints')
        .catch(() => undefined);
      return row?.n ?? 0;
    }

    private markDirty(): void {
      this.dirty = true;
      void this.ctx.storage.put(META_DIRTY, true);
      this.requestAlarm(Date.now() + FLUSH_DEBOUNCE_MS);
    }

    /** Arm the object's single alarm no later than `at` (multiplexed). */
    private requestAlarm(at: number): void {
      void this.ctx.storage.getAlarm().then((existing) => {
        if (existing === null || existing > at)
          return this.ctx.storage.setAlarm(at);
        return undefined;
      });
    }

    /**
     * One alarm, three clients: owner-store flush (debounced), the task
     * scheduler (when active), and week-idle eviction. Each tick runs what is
     * due and re-arms at the earliest future deadline.
     */
    async alarm(): Promise<void> {
      // Realtime heartbeat first, on the bare object: a round only needs
      // the hibernated sockets and their attachments. When nothing else is
      // due yet, re-arm and return WITHOUT opening the database — that is
      // what lets a user with an open tab cost a few milliseconds every
      // PING_INTERVAL_MS instead of a resident object.
      const wakeAt = Date.now();
      const nextPingAt =
        this.ctx.getWebSockets().length > 0 ? this.realtime.pingTick() : null;
      const housekeepingAt =
        await this.ctx.storage.get<number>(META_HOUSEKEEPING_AT);
      if (
        nextPingAt !== null &&
        housekeepingAt !== undefined &&
        housekeepingAt > wakeAt + 1000
      ) {
        await this.ctx.storage.setAlarm(Math.min(nextPingAt, housekeepingAt));
        return;
      }

      // Alarms routinely wake an EVICTED object: no db, no task scheduler,
      // dirty flag gone. Boot from the persisted identity first — a tick on
      // the un-booted object would skip every client and re-arm at the idle
      // horizon, silently dropping pending task runs and flushes.
      if (!this.db) {
        const storedDid = await this.ctx.storage.get<string>(META_USER_DID);
        if (storedDid) {
          try {
            await this.ready({ userDid: storedDid });
          } catch (err) {
            console.error(
              `[user-do] alarm boot failed for ${storedDid}: ${err instanceof Error ? err.message : String(err)}`,
            );
            // State exists but could not be opened — retry soon instead of
            // falling through to a schedulerless re-arm.
            await this.ctx.storage.setAlarm(Date.now() + 60_000);
            return;
          }
        }
      }
      if (
        this.db &&
        !this.dirty &&
        (await this.ctx.storage.get<boolean>(META_DIRTY)) === true
      ) {
        this.dirty = true;
      }

      const now = Date.now();
      const deadlines: number[] = [];

      if (this.dirty && this.db) {
        try {
          await this.flushToOwnerStore();
        } catch (err) {
          console.error(
            `[user-do] flush failed for ${this.userDid}: ${err instanceof Error ? err.message : String(err)}`,
          );
          deadlines.push(now + FLUSH_RETRY_DELAY_MS);
        }
      }

      if (this.taskScheduler) {
        try {
          await this.taskScheduler.onAlarm(now);
        } catch (err) {
          console.error(
            `[user-do] task scheduler tick failed for ${this.userDid}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const next = await this.taskScheduler.nextWakeAt().catch(() => null);
        if (next !== null) deadlines.push(Math.max(next, now + 1000));
      }

      // Legacy-blob compaction: one bounded batch per tick until the whole
      // file is codec-compressed (see sqlite/blob-compactor.ts). A flush in
      // flight holds a snapshot of the file, which the compactor's swap-in
      // cannot replace — a large migration flush (streamed, seconds long)
      // routinely overlaps the first tick, so wait for it instead of erroring.
      if (this.db && this.flushInFlight) {
        deadlines.push(now + 5000);
      } else if (this.db) {
        try {
          if (await this.compactionTick(this.db)) deadlines.push(now + 2000);
        } catch (err) {
          console.error(
            `[user-do] blob compaction tick failed for ${this.userDid}: ${err instanceof Error ? err.message : String(err)}`,
          );
          deadlines.push(now + 60_000);
        }
      }

      const lastAccess =
        (await this.ctx.storage.get<number>(META_LAST_ACCESS)) ?? now;

      // Free-page reclaim on a quiet object (policy in sqlite/vacuum-policy.ts):
      // runs after the flush above so the upload holds the pre-rebuild file,
      // and marks dirty so the smaller file goes up on the next tick.
      if (this.db && !this.dirty) {
        const next = await this.vacuumTick(this.db, now, lastAccess);
        if (next !== null) deadlines.push(next);
      }

      // Idle housekeeping: a user silent for a day loses the cached pages —
      // their file is safe upstream, and we stop paying to store a copy. Never
      // evict while tasks are scheduled: their runs ARE activity. The flush
      // above ran first; the wipe additionally verifies the upstream copy
      // matches the working copy, else the copy stays until it does.
      const idle = now - lastAccess > IDLE_EVICT_MS;
      if (idle && !this.dirty && this.db && deadlines.length === 0) {
        if (await this.ownerCopyIsCurrent(this.db)) {
          await this.wipeWorkingCopy(this.db);
          await this.ctx.storage.delete(META_HOUSEKEEPING_AT);
          // An attached (idle) socket still needs its heartbeat rounds.
          if (nextPingAt !== null) await this.ctx.storage.setAlarm(nextPingAt);
          else await this.ctx.storage.deleteAlarm();
          return;
        }
        console.warn(
          `[user-do] ${this.userDid} is idle but the owner copy is not verified current — keeping the working copy`,
        );
        deadlines.push(now + FLUSH_RETRY_DELAY_MS);
      }
      deadlines.push(now + IDLE_EVICT_MS);
      const housekeeping = Math.min(...deadlines);
      await this.ctx.storage.put(META_HOUSEKEEPING_AT, housekeeping);
      await this.ctx.storage.setAlarm(
        nextPingAt === null ? housekeeping : Math.min(housekeeping, nextPingAt),
      );
    }

    /**
     * One VACUUM policy check. Returns the time of a follow-up check when a
     * rebuild is wanted but the object is not quiet yet, else null.
     */
    private async vacuumTick(
      db: DoSqliteDatabase,
      now: number,
      lastAccessAt: number,
    ): Promise<number | null> {
      let usage: { pageCount: number; freelistCount: number };
      try {
        usage = await db.pageUsage();
      } catch (err) {
        console.warn(
          `[user-do] page usage unavailable for ${this.userDid}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
      const input = {
        now,
        lastAccessAt,
        lastVacuumAt: await this.ctx.storage.get<number>(META_LAST_VACUUM),
        dirty: this.dirty,
        exporting: this.flushInFlight !== null,
        fileBytes: db.fileSize,
        ...usage,
      };
      const verdict = shouldVacuum(input);
      if (!verdict.vacuum) {
        return vacuumWanted(input) ? now + VACUUM_IDLE_MS : null;
      }
      try {
        const { beforeBytes, afterBytes } = await db.compact();
        await this.ctx.storage.put(META_LAST_VACUUM, now);
        console.log(
          `[user-do] vacuumed ${this.userDid}: ${beforeBytes} → ${afterBytes} bytes (free share was ${(verdict.freeShare * 100).toFixed(0)}%)`,
        );
        this.markDirty();
      } catch (err) {
        console.error(
          `[user-do] vacuum failed for ${this.userDid}: ${err instanceof Error ? err.message : String(err)}`,
        );
        await this.ctx.storage.put(META_LAST_VACUUM, now);
      }
      return null;
    }

    // ── RPC surface (contracts.ts UserOracleObject) ───────────────────────

    async createSession(
      identity: TurnIdentity,
      o: { roomId?: string; sessionId?: string } = {},
    ): Promise<SessionSummary> {
      await this.ready(identity);
      const sessions = this.sessions!;
      // Like the Node runtime: creating a session sends the MOST RECENT
      // previous session's transcript to the memory engine, in the
      // background — the new session never waits on it.
      const { sessions: recent } = await sessions.listSessions(undefined, 1, 0);
      const previous = recent[0];
      if (previous) this.scheduleHistoryIndexing(previous.sessionId);
      let sessionId = o.sessionId;
      let roomId = o.roomId;
      if (!sessionId) {
        // Mirror the Node runtime: a session id IS a Matrix event id when the
        // user has an oracle room (clients rely on that for deep links).
        // `null` is the definitive "this user has no oracle room" (local id
        // below). A failing gateway is NOT that: swallowing it minted local
        // ids for users who do have rooms, and the room replays then
        // threaded on an id that is not a Matrix event id — which the
        // crypto WASM panics on. Transient failures retry, then fail the
        // request; the client retries and nothing half-exists.
        const room = roomId
          ? { roomId }
          : await retryGateway(() =>
              this.gateway.resolveUserRoom(identity.userDid),
            );
        if (room) {
          roomId = room.roomId;
          // The marker is a waited, non-durable send: it must never be
          // replayed after a gateway restart (its event id IS the session id,
          // an orphan marker would be a ghost session). Instead it retries
          // the same transaction id across the restart window, which the
          // homeserver deduplicates. Node fails the request on send failure;
          // so do we — no silent local id when the user has an oracle room.
          const txnId = `marker-${crypto.randomUUID()}`;
          sessionId = await retryGateway(
            () =>
              this.gateway.sendText(room.roomId, NEW_CONVERSATION_TEXT, {
                priority: 'interactive',
                durable: false,
                txnId,
              }),
            {
              onRetry: (err, attempt, delayMs) =>
                console.warn(
                  `[user-do] session marker send failed (attempt ${attempt}) — retrying in ${delayMs} ms: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                ),
            },
          );
        }
      }
      sessionId ??= `s_${crypto.randomUUID()}`;
      const row = await sessions.createSession({
        sessionId,
        roomId,
        oracleName: this.core.identity.name,
        oracleDid: this.env.ORACLE_DID,
        oracleEntityDid: this.core.identity.entityDid,
      });
      this.markDirty();
      return toSummary(row);
    }

    async listSessions(
      identity: TurnIdentity,
      o: { limit?: number; offset?: number } = {},
    ): Promise<{ sessions: SessionSummary[]; total: number }> {
      await this.ready(identity);
      // Task runs re-enter the agent as `task:<id>` sessions; like the Node
      // runtime (which lists only the user's main room) keep them out of
      // the user's session list.
      const { sessions, total } = await this.sessions!.listSessions(
        undefined,
        o.limit ?? 20,
        o.offset ?? 0,
        TASK_SESSION_PREFIX,
      );
      return { sessions: sessions.map(toSummary), total };
    }

    async deleteSession(
      identity: TurnIdentity,
      sessionId: string,
    ): Promise<boolean> {
      await this.ready(identity);
      this.aborts.get(sessionId)?.abort();
      // Node indexes a session into the memory engine as it is deleted.
      // The rows are gone once this RPC returns, so capture the transcript
      // now and let the background indexer read the snapshot.
      const doomed = await this.sessions!.getSession(sessionId);
      if (doomed) {
        this.historySnapshots.set(sessionId, {
          session: doomed,
          messages: await this.historyMessages(sessionId),
        });
        this.scheduleHistoryIndexing(sessionId);
      }
      const deleted = await this.sessions!.deleteSession(sessionId);
      if (deleted) {
        await this.saver!.deleteThread(sessionId);
        this.markDirty();
      }
      return deleted;
    }

    /** The session transcript as the indexer wants it (summarisation bookkeeping removed). */
    private async historyMessages(
      sessionId: string,
    ): Promise<HistoryMessage[]> {
      const messages = await this.saver!.listThreadMessages(sessionId);
      return messages
        .filter(
          (m) => !isSummarizationMessage(m) && !isAttachmentViewMessage(m),
        )
        .map((m) => ({ type: m.type, content: contentToText(m.content) }));
    }

    /**
     * Fire-and-forget session-history indexing (`SessionHistoryIndexer`).
     * The watermark lives in this object's storage (`history:processed:<id>`),
     * seeded from the row's `lastProcessedCount` for files migrated from Node;
     * `touchSession` is not used because it bumps `last_updated_at` and
     * would reorder the session list.
     */
    private scheduleHistoryIndexing(sessionId: string): void {
      const ambient = this.ambient;
      const userDid = this.userDid;
      if (!ambient || !this.sessions || !userDid) return;
      // The store/saver are looked up per call, not captured: a working-copy
      // reset re-opens the database while a run is in flight.
      this.historyIndexer ??= new SessionHistoryIndexer({
        memoryEngineUrl: (() => {
          const v = this.core.validatedEnv['MEMORY_ENGINE_URL'];
          return typeof v === 'string' && v.length > 0 ? v : undefined;
        })(),
        getSession: async (id) => {
          const snapshot = this.historySnapshots.get(id);
          const row =
            snapshot?.session ?? (await this.sessions?.getSession(id));
          if (!row) return undefined;
          return {
            ...(row.title !== undefined ? { title: row.title } : {}),
            ...(row.roomId !== undefined ? { roomId: row.roomId } : {}),
            // The same `last_processed_count` column the Node runtime keeps,
            // so a migrated file continues where it left off either way.
            lastProcessedCount: row.lastProcessedCount ?? 0,
          };
        },
        listMessages: async (id) =>
          this.historySnapshots.get(id)?.messages ??
          (await this.historyMessages(id)),
        setProcessedCount: async (id, count) => {
          if (this.historySnapshots.has(id)) return; // deleted: nothing to advance
          await this.sessions?.setLastProcessedCount(id, count);
          this.markDirty();
        },
        resolveUserRoom: () =>
          this.gateway.resolveUserRoom(userDid).catch(() => null),
        ucan: {
          hasSigningKey: () => ambient.ucan.hasSigningKey(),
          resolveServiceDid: (url) => ambient.ucan.resolveServiceDid(url),
          mintInvocation: (target, opts) =>
            ambient.ucan.mintInvocation(userDid, target, opts),
        },
        speakerLabels: async (roomId) => {
          const prefs = await this.preferences
            ?.get(roomId)
            .catch(() => undefined);
          const userName =
            typeof prefs?.userName === 'string' ? prefs.userName.trim() : '';
          const agentName =
            typeof prefs?.agentName === 'string' ? prefs.agentName.trim() : '';
          return {
            user: userName || 'Me',
            oracle: agentName || this.core.identity.name.trim() || 'Oracle',
          };
        },
        logger: console,
      });
      const indexer = this.historyIndexer;
      this.ctx.waitUntil(
        indexer
          .process(sessionId)
          .catch((err: unknown) => {
            console.error(
              `[user-do] session-history indexing failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          })
          .finally(() => {
            if (this.historySnapshots.has(sessionId)) {
              this.historySnapshots.delete(sessionId);
            }
          }),
      );
    }

    async listMessages(
      identity: TurnIdentity,
      sessionId: string,
    ): Promise<string> {
      await this.ready(identity);
      const messages = (await this.saver!.listThreadMessages(sessionId)).filter(
        (m) => !isSummarizationMessage(m),
      );
      const { messages: dtos } = await transformTranscript(messages);
      return JSON.stringify(dtos);
    }

    /**
     * The shell deposited a (new) delegation for this user: adopt it now so
     * header-less turns mint from it immediately. Does not boot the object.
     */
    async setDelegation(
      userDid: string,
      raw: string,
      expiration?: number,
    ): Promise<void> {
      this.delegations.set(userDid, { raw });
      this.delegationMissUntil = 0;
      await this.ctx.storage.put(META_DELEGATION, {
        raw,
        at: Date.now(),
        ...(typeof expiration === 'number' ? { expiration } : {}),
      } satisfies StoredDelegation);
      await this.onDelegationReplaced();
    }

    /**
     * The user revoked their delegation: forget the cached copy so plugin
     * mints stop at once (Node's `revokeDelegationForUser` clears its cache
     * for the same reason). The next header-less turn re-reads the room
     * state, which the shell has already cleared.
     */
    async clearDelegation(userDid: string): Promise<void> {
      this.delegations.delete(userDid);
      this.delegationMissUntil = 0;
      await this.ctx.storage.delete(META_DELEGATION);
    }

    async finishWorkStatus(
      requestId: string,
      phase: 'done' | 'superseded',
    ): Promise<void> {
      this.workStatus?.finish(requestId, phase);
      for (const [sessionId, inFlight] of this.matrixTurns)
        if (inFlight === requestId) this.matrixTurns.delete(sessionId);
    }

    /**
     * Ask the web app to open its "authorize for Matrix" modal in place when a
     * Matrix turn finds no valid delegation — the Node AgentBuilder's
     * `maybePromptReauth`, throttled per object
     * (`UCAN_REAUTH_PROMPT_THROTTLE_SECONDS`, default 6 h). Never throws; the
     * prompt outlives the turn under `waitUntil` while it is retried across a
     * gateway restart (see reauth-prompt.ts for the ordering that matters).
     */
    private promptReauth(userDid: string, roomId: string): void {
      this.reauthPrompter ??= new ReauthPrompter({
        throttleMs: reauthThrottleSeconds(this.env) * 1000,
        getStamp: () => this.ctx.storage.get<number>(META_REAUTH_PROMPT_AT),
        setStamp: (at) => this.ctx.storage.put(META_REAUTH_PROMPT_AT, at),
        send: (room) =>
          this.gateway.sendEvent(
            room,
            'ixo.oracle.delegation_required',
            JSON.stringify({
              oracleEntityDid: this.core.identity.entityDid,
              oracleDid: this.env.ORACLE_DID,
            }),
          ),
        keepAlive: (work) => this.ctx.waitUntil(work),
        log: (message) => console.log(message),
        warn: (message) => console.warn(message),
      });
      void this.reauthPrompter.prompt(userDid, roomId);
    }

    /** Debug route: forget when the last re-authorise prompt was posted, so a drill can trigger the next one. */
    async debugResetReauthThrottle(): Promise<void> {
      await this.ctx.storage.delete(META_REAUTH_PROMPT_AT);
    }

    /**
     * A turn that died mid-way leaves committed checkpoint steps with no dirty
     * mark (the mark is set at the end of a turn). Compare the file's write
     * generation with the last upload's on boot and mark the copy dirty when
     * it moved on; one batched storage read per boot (see boot-dirty.ts).
     */
    private async reconcileDirtyOnBoot(
      db: DoSqliteDatabase,
      userDid: string,
    ): Promise<void> {
      if (this.dirty) return;
      const got = await this.ctx.storage.get<unknown>([
        META_DIRTY,
        META_UPLOADED_GEN,
      ]);
      const decision = decideBootDirty({
        dirtyInMemory: this.dirty,
        dirtyFlag: got.get(META_DIRTY),
        uploadedGen: got.get(META_UPLOADED_GEN),
        writeGeneration: db.writeGeneration,
      });
      if (decision === 'flagged') {
        // The mark is on disk already (its flush alarm too); just adopt it.
        this.dirty = true;
        this.requestAlarm(Date.now() + FLUSH_DEBOUNCE_MS);
      } else if (decision === 'behind-upload') {
        console.log(
          `[user-do] working copy of ${userDid} is at generation ${db.writeGeneration}, last upload at ${String(got.get(META_UPLOADED_GEN))} — a turn ended without marking it; flushing`,
        );
        this.markDirty();
      }
    }

    /** Operator probe (`GET /debug/delegation`): what header-less turns would mint from. */
    async delegationStatus(userDid: string): Promise<{
      present: boolean;
      expiration?: number;
      source: 'memory' | 'storage' | 'none';
    }> {
      const stored =
        await this.ctx.storage.get<StoredDelegation>(META_DELEGATION);
      const inMemory = this.delegations.get(userDid);
      if (inMemory) {
        return {
          present: true,
          source: 'memory',
          ...(typeof stored?.expiration === 'number'
            ? { expiration: stored.expiration }
            : {}),
        };
      }
      if (stored?.raw) {
        return {
          present: true,
          source: 'storage',
          ...(typeof stored.expiration === 'number'
            ? { expiration: stored.expiration }
            : {}),
        };
      }
      return { present: false, source: 'none' };
    }

    async abortTurn(sessionId: string): Promise<boolean> {
      const controller = this.aborts.get(sessionId);
      if (!controller) return false;
      controller.abort();
      this.aborts.delete(sessionId);
      return true;
    }

    /**
     * A room turn runs at most once per Matrix event, however many times the
     * gateway asks (it asks again after a reset, see the inbox in
     * `src/matrix/gateway-do.ts`). The ledger and the in-flight map decide:
     * answered → stored reply; running → attach; started but lost in a reset
     * of this object → refused (tools may have run), the user is told to
     * retry; unknown → run once. HTTP and task turns carry no event id and
     * always run.
     */
    async runTurn(req: TurnRequest): Promise<TurnResult> {
      await this.ready(req.identity);
      const eventId = req.client === 'matrix' ? req.eventId : undefined;
      const ledger = this.matrixLedger;
      if (!eventId || !ledger) return this.runTurnOnce(req);

      const running = this.matrixTurnRuns.get(eventId);
      if (running) {
        console.log(
          `[user-do] turn for ${eventId} is still running; the gateway asked again and attaches to it`,
        );
        return running;
      }
      const existing = await ledger.get(eventId);
      switch (decideMatrixTurn(existing)) {
        case 'answered':
          console.log(
            `[user-do] turn for ${eventId} already answered; returning the stored reply`,
          );
          return {
            sessionId: req.sessionId,
            requestId: req.requestId,
            text: existing?.replyText ?? '',
            toolCalls: [],
            replayed: true,
          };
        case 'interrupted':
          throw new Error(`${TURN_INTERRUPTED_MARKER} (${eventId})`);
        case 'run':
          break;
      }
      await ledger.start(eventId, req.sessionId, req.requestId);
      const run = this.runTurnOnce(req)
        .then(async (result) => {
          await ledger.answer(eventId, result.text);
          return result;
        })
        .finally(() => {
          this.matrixTurnRuns.delete(eventId);
        });
      this.matrixTurnRuns.set(eventId, run);
      // The turn's I/O belongs to this RPC's request context. If the gateway
      // that made the call is reset, the context would be cancelled with it:
      // fetches started afterwards (the next model call, the next tool) never
      // settle, and the turn hangs forever — with a replay attached to it.
      // `waitUntil` keeps the context alive until the turn has ended, so the
      // turn finishes, the ledger records the reply, and the replayed request
      // returns it.
      this.ctx.waitUntil(run.catch(() => undefined));
      return run;
    }

    private async runTurnOnce(req: TurnRequest): Promise<TurnResult> {
      // Matrix turns drive a `work_status` card in the user's thread; a newer
      // message on the same session supersedes the previous card (the
      // previous turn itself is aborted by prepareTurn).
      const card =
        req.client === 'matrix' && req.roomId && req.eventId && this.workStatus
          ? this.workStatus
          : null;
      if (card && req.roomId && req.eventId) {
        const previous = this.matrixTurns.get(req.sessionId);
        if (previous && previous !== req.requestId)
          card.finish(previous, 'superseded');
        this.matrixTurns.set(req.sessionId, req.requestId);
        card.beginTurn({
          requestId: req.requestId,
          roomId: req.roomId,
          threadId: req.threadId ?? req.eventId,
          sessionId: req.sessionId,
          forEventId: req.eventId,
        });
        card.emit(req.requestId, 'routing');
      }
      const { agent, stateInput, config, abortController, turnDisposables } =
        await this.prepareTurn(req, {
          message: req.message,
          timezone: req.identity.timezone,
          model: req.model,
          attachments: req.attachments,
        });
      try {
        const result = (await agent.invoke(stateInput, config)) as {
          messages?: BaseMessage[];
        };
        const messages = result.messages ?? [];
        const text = lastAiText(messages);
        await this.afterTurn(req.sessionId, messages);
        await this.runTurnDisposables(turnDisposables);
        card?.emit(req.requestId, 'delivering');
        const toolCalls = messages
          .filter((m): m is AIMessage => m.type === 'ai')
          .flatMap((m) =>
            (m.tool_calls ?? []).map((t) => ({
              name: t.name,
              status: 'done' as const,
            })),
          );
        return {
          sessionId: req.sessionId,
          requestId: req.requestId,
          text,
          ...(lastAiMessageId(messages) !== undefined
            ? { messageId: lastAiMessageId(messages) }
            : {}),
          toolCalls,
        };
      } finally {
        if (this.aborts.get(req.sessionId) === abortController)
          this.aborts.delete(req.sessionId);
      }
    }

    /**
     * One bounded blob-compaction step. Returns true while work remains.
     * On completion: reclaim pages and export the (smaller) file.
     */
    private async compactionTick(db: DoSqliteDatabase): Promise<boolean> {
      this.compactDone ??=
        (await this.ctx.storage.get<boolean>(META_COMPACT_DONE)) ?? false;
      if (this.compactDone) return false;
      this.compactCursors ??=
        (await this.ctx.storage.get<CompactCursors>(META_COMPACT_CURSORS)) ??
        {};
      const step = await compactStep(db, COMPACT_BATCH, this.compactCursors);
      this.compactCursors = step.cursors;
      await this.ctx.storage.put(META_COMPACT_CURSORS, step.cursors);
      if (step.savedBytes > 0) {
        const prior =
          (await this.ctx.storage.get<number>(META_COMPACT_SAVED)) ?? 0;
        await this.ctx.storage.put(META_COMPACT_SAVED, prior + step.savedBytes);
      }
      if (!step.done) return true;
      const { vacuumed } = await finishCompaction(db, {
        fileSize: db.fileSize,
      });
      this.compactDone = true;
      await this.ctx.storage.put(META_COMPACT_DONE, true);
      const saved =
        (await this.ctx.storage.get<number>(META_COMPACT_SAVED)) ?? 0;
      if (saved > 0) {
        console.log(
          `[user-do] blob compaction complete for ${this.userDid}: ${saved} bytes saved (${vacuumed} vacuum), exporting the compacted file`,
        );
        // One export at the end, not per batch — flushing a multi-GB file
        // after every 300 rows would dwarf the savings.
        this.markDirty();
      }
      return false;
    }

    /**
     * Slack watermark alert when the working copy crosses a new whole-GB
     * threshold toward the 10 GB DO cap. Fire-and-forget off the flush path.
     */
    private checkSizeAlert(fileBytes: number): void {
      const webhook = this.env.SLACK_ALERT_WEBHOOK_URL;
      const userDid = this.userDid;
      if (!webhook || !userDid) return;
      void (async () => {
        this.sizeAlertGb ??=
          (await this.ctx.storage.get<number>(META_SIZE_ALERT_GB)) ?? 0;
        const gb = crossedGbThreshold(fileBytes, this.sizeAlertGb);
        if (gb === null) return;
        this.sizeAlertGb = gb;
        await this.ctx.storage.put(META_SIZE_ALERT_GB, gb);
        await postSlackAlert(
          webhook,
          storageAlertText({
            oracleName: this.core.identity.name,
            oracleDid: this.env.ORACLE_DID,
            userDid,
            fileBytes,
            gb,
          }),
        );
        console.warn(
          `[user-do] storage watermark alert sent: ${userDid} crossed ${gb} GB`,
        );
      })().catch((err: unknown) => {
        console.warn(
          `[user-do] size alert failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }

    /**
     * Push the working copy to the user's owner store — without ever holding
     * the file in memory:
     *
     *   1. nothing written since the last upload (VFS write generation) →
     *      done, no reads at all;
     *   2. otherwise pin a snapshot (SQLite keeps committing; the VFS shadows
     *      the pages the snapshot needs) and hash it in one streamed pass —
     *      same checksum as last time → done, no upload;
     *   3. otherwise the store streams the snapshot upstream (gzip → tus
     *      parts → temp path → swap; see `IxoVfsOwnerStore.save`).
     *
     * A failed upload leaves the copy dirty for the next tick; after
     * `FLUSH_FALLBACK_AFTER_FAILURES` consecutive failures the legacy Matrix
     * media path takes the snapshot instead, loudly. Single-flight: a call
     * while one runs joins it.
     */
    async flushToOwnerStore(): Promise<FlushResult> {
      if (!this.db) {
        // A cold (evicted) object: boot from the persisted identity first, so
        // an operator's `POST /debug/storage/flush` is never a silent no-op.
        const userDid =
          this.userDid ?? (await this.ctx.storage.get<string>(META_USER_DID));
        if (userDid) await this.ready({ userDid });
      }
      if (this.flushInFlight) return this.flushInFlight;
      const run = this.flushOnce().finally(() => {
        this.flushInFlight = null;
      });
      this.flushInFlight = run;
      return run;
    }

    private async flushOnce(): Promise<FlushResult> {
      const db = this.db;
      const store = this.ownerStore;
      if (!db || !store) return { uploaded: false, bytes: 0 };
      this.checkSizeAlert(db.fileSize);
      const knownEtag = await this.ctx.storage.get<string>(META_OWNER_ETAG);
      const uploadedGen = await this.ctx.storage.get<number>(META_UPLOADED_GEN);
      if (uploadedGen !== undefined && uploadedGen === db.writeGeneration) {
        await this.clearDirty();
        return {
          uploaded: false,
          bytes: db.fileSize,
          etag: knownEtag,
          skipped: 'unchanged-generation',
        };
      }

      const snapshot = await db.snapshot();
      try {
        const checksum = await sha256OfStream(snapshot.open());
        const last = await this.ctx.storage.get<string>(META_LAST_CHECKSUM);
        if (last === checksum) {
          await this.ctx.storage.put(META_UPLOADED_GEN, snapshot.generation);
          await this.clearDirty();
          return {
            uploaded: false,
            bytes: snapshot.size,
            etag: knownEtag,
            skipped: 'unchanged-checksum',
          };
        }

        let saved: { etag: string; bytes: number };
        try {
          saved = await store.save(snapshot);
        } catch (err) {
          // Never diverted anywhere else: the working copy in Durable Object
          // storage is durable, stays dirty, and is retried. Loud from the
          // third consecutive failure so an outage (or a user without an
          // `ixo:filesystem` delegation) is visible in the logs.
          const failures =
            ((await this.ctx.storage.get<number>(META_FLUSH_FAILURES)) ?? 0) +
            1;
          await this.ctx.storage.put(META_FLUSH_FAILURES, failures);
          const detail = err instanceof Error ? err.message : String(err);
          const line = `[user-do] owner-store flush failed (${failures} in a row) for ${this.userDid} — working copy kept dirty, retrying in ${FLUSH_RETRY_DELAY_MS / 60_000} min: ${detail}`;
          if (failures >= FLUSH_FAILURES_ERROR_THRESHOLD) console.error(line);
          else console.warn(line);
          throw err;
        }
        await this.ctx.storage.put(META_OWNER_ETAG, saved.etag);
        await this.ctx.storage.put(META_LAST_CHECKSUM, checksum);
        await this.ctx.storage.put(META_LAST_FLUSH, Date.now());
        await this.ctx.storage.put(META_UPLOADED_GEN, snapshot.generation);
        await this.ctx.storage.delete(META_FLUSH_FAILURES);
        await this.clearDirty();
        console.log(
          `[user-do] flushed ${snapshot.size} bytes (${saved.bytes} sent) to ${store.kind} for ${this.userDid} (${saved.etag})`,
        );
        const legacyRemoved = await this.removeLegacyCopyIfAny(saved.etag);
        return {
          uploaded: true,
          bytes: saved.bytes,
          etag: saved.etag,
          ...(legacyRemoved ? { legacyRemoved } : {}),
        };
      } finally {
        snapshot.close();
      }
    }

    /**
     * Remove the user's legacy Matrix copy once VFS is confirmed to hold
     * `etag` (just uploaded, or just loaded from VFS). Runs at most until it
     * succeeds or finds no legacy copy — then `META_LEGACY_CLEARED` stops the
     * lookups for good. Errors are logged and retried on the next occasion.
     */
    private async removeLegacyCopyIfAny(etag: string): Promise<boolean> {
      const store = this.ownerStore;
      if (!store?.removeLegacyCopy) return false;
      if (await this.ctx.storage.get<boolean>(META_LEGACY_CLEARED))
        return false;
      // Defence in depth: never drop the backstop for an empty working copy —
      // a zero-turn file is not worth confirming against, and redacting here
      // would strip a migrated user's only history if VFS held a stub.
      if (this.db && (await this.localTurnCount(this.db)) === 0) return false;
      try {
        const removed = await store.removeLegacyCopy(etag);
        await this.ctx.storage.put(META_LEGACY_CLEARED, true);
        if (removed) {
          console.log(
            `[user-do] legacy Matrix copy removed for ${this.userDid}; VFS is the only copy`,
          );
        }
        return removed;
      } catch (err) {
        console.warn(
          `[user-do] legacy Matrix copy check failed for ${this.userDid} (will retry): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return false;
      }
    }

    /** Run (and forget) the cleanups a turn registered; each at most once. */
    private async runTurnDisposables(
      disposables: Set<() => void | Promise<void>>,
    ): Promise<void> {
      const pending = [...disposables];
      disposables.clear();
      if (pending.length > 0)
        console.log(
          `[user-do] turn cleanup: running ${pending.length} dispose(s)`,
        );
      for (const dispose of pending) {
        try {
          await dispose();
        } catch (err) {
          console.warn(
            `[user-do] turn cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    private async clearDirty(): Promise<void> {
      // A write that landed while the snapshot was being uploaded already
      // re-armed the alarm through `markDirty`; only clear when the file's
      // generation still matches what was just recorded.
      const uploadedGen = await this.ctx.storage.get<number>(META_UPLOADED_GEN);
      if (
        this.db &&
        uploadedGen !== undefined &&
        uploadedGen !== this.db.writeGeneration
      )
        return;
      this.dirty = false;
      await this.ctx.storage.delete(META_DIRTY);
    }

    async resetWorkingCopy(): Promise<{ reloadedFromOwnerStore: boolean }> {
      const userDid =
        this.userDid ?? (await this.ctx.storage.get<string>(META_USER_DID));
      // On a cold (evicted) object the in-memory dirty flag is gone — boot and
      // consult the persisted marker, or the wipe below discards changes the
      // owner store never received.
      if (!this.db && userDid) await this.ready({ userDid });
      if (
        this.dirty ||
        (await this.ctx.storage.get<boolean>(META_DIRTY)) === true
      ) {
        this.dirty = true;
        await this.flushToOwnerStore();
      }
      await this.wipeWorkingCopy(this.db);
      this.db = null;
      this.saver = null;
      this.sessions = null;
      this.matrixLedger = null;
      this.sessionRooms.clear();
      this.ambient = null;
      this.secretsService = null;
      this.byo = null;
      this.initPromise = null;
      this.reloadedFromOwnerStore = false;
      if (userDid) await this.ready({ userDid });
      return { reloadedFromOwnerStore: this.reloadedFromOwnerStore };
    }

    /**
     * `GET /debug/sessions/:id` — the raw session row (incl.
     * `lastProcessedCount`, which the public listing does not expose) so a
     * test can observe history indexing without going through the memory
     * engine.
     */
    async debugSession(
      userDid: string,
      sessionId: string,
    ): Promise<Record<string, unknown> | null> {
      await this.ready({ userDid });
      const session = await this.sessions!.getSession(sessionId);
      if (!session) return null;
      // Whether the thread's agent context was condensed: the summarization
      // middleware's bookkeeping message is stored with the history but
      // never listed, so `GET /messages/:id` alone cannot tell.
      const all = await this.saver!.listThreadMessages(sessionId);
      return {
        ...session,
        threadMessages: all.length,
        summaryMessages: all.filter(isSummarizationMessage).length,
        // Folded into their assistant messages by the listing, not shown alone.
        toolMessages: all.filter((m) => m.type === 'tool').length,
      };
    }

    /**
     * `GET /debug/memory-schema` — fetch the memory engine's tool list with
     * this user's credentials and return `search_memory_engine`'s raw schema
     * plus whether it converts to Zod. Same headers the memory plugin sends.
     */
    /**
     * Operator / testing aid behind `ORACLE_DEBUG_ROUTES`: reset this object
     * the way an unplanned platform reset does — in-memory state and every
     * in-flight turn are gone, committed storage survives, the next request
     * boots a fresh instance. The RPC rejects by design.
     */
    async debugAbortObject(): Promise<void> {
      this.ctx.abort('debug reset requested');
    }

    async debugMemorySchema(userDid: string): Promise<MemorySchemaDebug> {
      await this.ready({ userDid });
      const ambient = this.ambient;
      const url = this.core.validatedEnv['MEMORY_MCP_URL'];
      if (!ambient || typeof url !== 'string' || url.length === 0) {
        return { error: 'MEMORY_MCP_URL is not configured' };
      }
      const memoryDid = await ambient.ucan.resolveServiceDid(url);
      if (!memoryDid)
        return { error: 'memory engine DID could not be resolved' };
      const invocation = await ambient.ucan.mintInvocation(
        userDid,
        { did: memoryDid, capability: 'ixo:memory' },
        { can: 'memory/*' },
      );
      if (!invocation)
        return { error: 'no UCAN invocation for the memory engine' };
      const room = await this.gateway
        .resolveUserRoom(userDid)
        .catch(() => null);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${invocation}`,
        'X-Auth-Type': 'ucan',
        'User-Agent': 'LangChain-MCP-Client/1.0',
        ...(room?.roomId ? { 'x-room-id': room.roomId } : {}),
      };
      try {
        return (
          (await fetchMemorySchemaDump(url, headers)) ?? {
            error: 'search_memory_engine not in the tool list',
          }
        );
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }

    async storageStatus(): Promise<StorageStatus> {
      const db = this.db;
      const fileBytes = db?.fileSize ?? 0;
      const vfs = db?.vfsStats();
      const usage = db
        ? await db.pageUsage().catch(() => undefined)
        : undefined;
      return {
        instanceId: this.instanceId,
        instanceUptimeMs: Date.now() - this.bootedAt,
        memorySchemaDump: getMemorySchemaDump(),
        fileBytes,
        pages: Math.ceil(fileBytes / 4096),
        ownerEtag: await this.ctx.storage.get<string>(META_OWNER_ETAG),
        lastFlushAt: await this.ctx.storage.get<number>(META_LAST_FLUSH),
        dirty: this.dirty,
        flushInFlight: this.flushInFlight !== null,
        writeGeneration: db?.writeGeneration,
        uploadedGeneration:
          await this.ctx.storage.get<number>(META_UPLOADED_GEN),
        lastChecksum: await this.ctx.storage.get<string>(META_LAST_CHECKSUM),
        flushFailures:
          (await this.ctx.storage.get<number>(META_FLUSH_FAILURES)) ?? 0,
        lastVacuumAt: await this.ctx.storage.get<number>(META_LAST_VACUUM),
        legacyCleared:
          (await this.ctx.storage.get<boolean>(META_LEGACY_CLEARED)) === true,
        lastAccessAt: await this.ctx.storage.get<number>(META_LAST_ACCESS),
        indexingInFlight: this.historyIndexer?.inFlightCount ?? 0,
        activeTurns: this.aborts.size,
        pendingTimers: timerTrackerInstalled()
          ? pendingTimers().length
          : undefined,
        alarmAt: await this.ctx.storage.getAlarm(),
        pageCount: usage?.pageCount,
        freelistCount: usage?.freelistCount,
        sqliteCacheSize: db
          ? await db.cacheSizePragma().catch(() => undefined)
          : undefined,
        chunkCache: vfs
          ? {
              budgetBytes: vfs.cacheBudgetBytes,
              capacityChunks: vfs.cacheCapacityChunks,
              cachedBytes: vfs.cachedPages * 4096,
              hits: vfs.cacheHits,
              misses: vfs.cacheMisses,
              storageReads: vfs.storageReads,
              rowsRead: vfs.rowsRead,
              storageWrites: vfs.storageWrites,
              rowsWritten: vfs.rowsWritten,
            }
          : undefined,
      };
    }

    async tasksStatus(userDid?: string): Promise<{
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
      }>;
      openRuns: Array<{
        runId: string;
        taskId: string;
        startedAt: string;
        state: 'running' | 'delivering';
        attempts: number;
        retryAt: number | null;
      }>;
    }> {
      // A cold (evicted or reset) object has no scheduler until it boots;
      // reporting "no tasks" for it would be wrong, so boot like the alarm
      // does when the caller — or the stored identity — says whose object.
      if (!this.taskScheduler) {
        const did =
          userDid ?? (await this.ctx.storage.get<string>(META_USER_DID));
        if (did) await this.ready({ userDid: did });
      }
      const records = this.taskScheduler
        ? await this.taskScheduler.surface.list()
        : [];
      const openRuns = this.taskScheduler
        ? await this.taskScheduler.openRuns()
        : [];
      return {
        now: Date.now(),
        alarm: await this.ctx.storage.getAlarm(),
        schedulerActive: this.taskScheduler !== null,
        openRuns: openRuns.map((r) => ({
          runId: r.runId,
          taskId: r.taskId,
          startedAt: r.startedAt,
          state: r.state,
          attempts: r.attempts,
          retryAt: r.retryAt ?? null,
        })),
        tasks: records.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          nextRunAt: t.nextRunAt ?? null,
          lastResult: t.lastResult ?? null,
          consecutiveFailures: t.consecutiveFailures,
          deliveryRoomId: t.deliveryRoomId ?? null,
        })),
      };
    }

    // ── realtime (socket.io) channel ─────────────────────────────────────

    /**
     * The socket.io endpoint of this object. Built lazily: the first socket
     * upgrade, hibernation callback or turn needing `ctx.frontend` creates
     * it, and its constructor re-adopts sockets that survived a restart.
     */
    private get realtime(): RealtimeEndpoint {
      this.realtimeEndpoint ??= new RealtimeEndpoint({
        ctx: this.ctx,
        authenticate: (auth) => {
          const headers = new Headers();
          if (auth.invocation) {
            headers.set('authorization', `Bearer ${auth.invocation}`);
            headers.set('x-auth-type', 'ucan');
          }
          if (auth.ucanDelegation)
            headers.set('x-ucan-delegation', auth.ucanDelegation);
          return authenticate(headers, {
            oracleDid: this.env.ORACLE_DID,
            blocksyncUri: this.env.BLOCKSYNC_GRAPHQL_URL,
            maxTtlSeconds: this.env.UCAN_AUTH_MAX_TTL_SECONDS
              ? Number(this.env.UCAN_AUTH_MAX_TTL_SECONDS)
              : undefined,
          });
        },
        sessionExists: async (userDid, sessionId) => {
          await this.ready({ userDid });
          return Boolean(await this.sessions!.getSession(sessionId));
        },
        router: this.events,
        logger: console,
        requestAlarm: (at) => this.requestAlarm(at),
        // Node indexes a session into the memory engine when its last socket
        // disconnects (`WsService.removeClientConnection`); same trigger here.
        onSessionDrained: (sessionId) =>
          this.scheduleHistoryIndexing(sessionId),
      });
      return this.realtimeEndpoint;
    }

    async realtimeStatus(): Promise<RealtimeStatus> {
      return {
        ...this.realtime.status(),
        ...(timerTrackerInstalled() ? { pendingTimers: pendingTimers() } : {}),
      };
    }

    /**
     * With `ORACLE_DEBUG_ROUTES=true`, record every live timer so
     * `GET /debug/realtime` can show what keeps the object resident (a
     * pending timer blocks WebSocket hibernation). Idempotent per isolate.
     */
    private installDebugTimerTracker(): void {
      if (this.env.ORACLE_DEBUG_ROUTES === 'true') installTimerTracker();
    }

    override async webSocketMessage(
      ws: WebSocket,
      message: string | ArrayBuffer,
    ): Promise<void> {
      await this.realtime.onMessage(ws, message);
    }

    override async webSocketClose(ws: WebSocket): Promise<void> {
      this.realtime.onClose(ws);
    }

    override async webSocketError(
      ws: WebSocket,
      error: unknown,
    ): Promise<void> {
      this.realtime.onError(ws, error);
    }

    // ── HTTP surface (used by the shell for streaming turns) ─────────────

    override async fetch(request: Request): Promise<Response> {
      this.installDebugTimerTracker();
      const url = new URL(request.url);
      if (url.pathname.startsWith('/socket.io')) {
        return this.realtime.handleUpgrade(request, url);
      }
      if (url.pathname.startsWith('/byo-llm/')) {
        const byoIdentity = JSON.parse(
          request.headers.get('x-identity') ?? '{}',
        ) as TurnIdentity;
        if (!byoIdentity.userDid) {
          return Response.json(
            { statusCode: 400, message: 'x-identity is required' },
            { status: 400 },
          );
        }
        try {
          await this.ready(byoIdentity);
        } catch (err) {
          return readyFailureResponse(err);
        }
        return handleByoRequest(
          this.byo!,
          byoIdentity.userDid,
          request,
          console,
        );
      }
      const match = /^\/turn\/([^/]+)$/.exec(url.pathname);
      if (!match || request.method !== 'POST')
        return new Response('Not found', { status: 404 });
      const sessionId = decodeURIComponent(match[1]!);
      const identity = JSON.parse(
        request.headers.get('x-identity') ?? '{}',
      ) as TurnIdentity;
      const requestId =
        request.headers.get('x-request-id') ?? crypto.randomUUID();
      const parsed = parseTurnBody(await request.text());
      if (!parsed.ok) {
        return Response.json(
          { statusCode: parsed.status, message: parsed.message },
          { status: parsed.status },
        );
      }
      const body = parsed.body;
      try {
        await this.ready(identity);
      } catch (err) {
        return readyFailureResponse(err);
      }
      if (!(await this.sessions!.getSession(sessionId))) {
        return Response.json(
          { statusCode: 404, message: `Session ${sessionId} not found` },
          { status: 404 },
        );
      }
      // Validate attachments up front so a malformed payload is a 400 (the
      // Node DTO's behaviour), not a failed turn.
      let attachments: ReturnType<typeof parseAttachmentInputs>;
      try {
        attachments = parseAttachmentInputs(body.attachments);
      } catch (err) {
        return Response.json(
          {
            statusCode: 400,
            message: err instanceof Error ? err.message : String(err),
          },
          { status: 400 },
        );
      }
      const req: TurnRequest = {
        identity: { ...identity, timezone: body.timezone ?? identity.timezone },
        sessionId,
        message: body.message,
        client: 'portal',
        requestId,
        model: body.model,
        metadata: body.metadata ? JSON.stringify(body.metadata) : undefined,
        ...(attachments.length > 0 ? { attachments } : {}),
      };
      const stream = body.stream !== false;
      if (!stream) {
        this.replayToRoom(req, body.message, 'user');
        try {
          const result = await this.runTurn(req);
          this.replayToRoom(req, result.text, 'oracle');
          // Node's `SendMessageResponse.message` is `{ type, content, id }`.
          const payload: Record<string, unknown> = {
            message: {
              type: 'ai',
              content: result.text,
              id: result.messageId ?? requestId,
            },
            sessionId,
            requestId,
          };
          if (body.returnAllMessages)
            payload.messages = JSON.parse(
              await this.listMessages(identity, sessionId),
            );
          return Response.json(payload, {
            headers: { 'x-request-id': requestId },
          });
        } catch (err) {
          return Response.json(
            {
              statusCode: 500,
              message: err instanceof Error ? err.message : 'Turn failed',
              requestId,
            },
            { status: 500, headers: { 'x-request-id': requestId } },
          );
        }
      }

      const {
        agent,
        stateInput,
        config,
        abortController,
        byoNotice,
        byoProvider,
        turnDisposables,
      } = await this.prepareTurn(req, body);
      this.replayToRoom(req, body.message, 'user');
      const agActionNames = new Set((body.agActions ?? []).map((a) => a.name));
      const sink = {
        emit: (eventName: string, payload: Record<string, unknown>) => {
          void payload;
          void eventName;
        },
      };
      let write: ((name: string, payload: unknown) => void) | null = null;
      sink.emit = (eventName, payload) => write?.(eventName, payload);
      this.events.register(sessionId, sink);
      const events = agent.streamEvents(stateInput, {
        ...config,
        version: 'v2',
      });
      const capture: BaseMessage[] = [];
      const sse = createSseTurnStream({
        events: tapMessages(events, capture),
        sessionId,
        requestId,
        abortController,
        mirror: (eventName, payload) =>
          this.events.emitToTaps(eventName, payload),
        agActionNames,
        byoProvider,
        onComplete: async () => {
          this.replayToRoom(req, lastAiText(capture), 'oracle');
          await this.afterTurn(sessionId, capture);
          await this.runTurnDisposables(turnDisposables);
        },
        onError: (err) => {
          console.error(`[user-do] turn ${requestId} failed:`, err);
          void this.runTurnDisposables(turnDisposables);
        },
        log: (m) => console.log(`[user-do] ${m}`),
      });
      // Let plugin-emitted events (ctx.emit.*) ride the same SSE stream.
      const [clientBranch, emitterBranch] = sse.tee();
      void emitterBranch.cancel();
      write = null;
      const merged = mergeWithEmitter(clientBranch, (register) => {
        write = register;
      });
      // A BYO turn that degraded to the platform model tells the user so —
      // the Node runtime emits the same notice on the SSE `error` channel.
      if (byoNotice) sink.emit('error', { ...byoNotice, sessionId, requestId });
      const cleanup = () => {
        this.events.unregister(sessionId, sink);
        if (this.aborts.get(sessionId) === abortController)
          this.aborts.delete(sessionId);
      };
      const finalStream = merged.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform: (chunk, controller) => controller.enqueue(chunk),
          flush: cleanup,
        }),
      );
      return new Response(finalStream, {
        headers: { ...SSE_HEADERS, 'x-request-id': requestId },
      });
    }

    // ── turn plumbing ──────────────────────────────────────────────────────

    /**
     * Matrix media access for the attachments pipeline, through the gateway.
     * Both transfers stream across the object boundary and are cut off at
     * the attachment cap; an encrypted attachment is decrypted HERE, not in
     * the gateway (its whole-buffer download grew the crypto WASM heap for
     * good, and a hash mismatch on the far side of the RPC would only reach
     * this object as a disconnect).
     */
    private matrixMediaSource(): MatrixMediaSource {
      return {
        downloadMxc: async (mxc, maxBytes = MAX_FILE_SIZE) =>
          readBytesCapped(
            await this.gateway.downloadMxcMediaStream(mxc),
            maxBytes,
          ),
        downloadEvent: async (roomId, eventId, maxBytes = MAX_FILE_SIZE) => {
          const media = await this.gateway.downloadEventMediaStream(
            roomId,
            eventId,
          );
          if (!media) return null;
          const plain = media.file
            ? media.stream.pipeThrough(createAttachmentDecryptor(media.file))
            : media.stream;
          return {
            bytes: await readBytesCapped(plain, maxBytes),
            ...(media.mimetype ? { mimetype: media.mimetype } : {}),
            ...(media.filename ? { filename: media.filename } : {}),
          };
        },
      };
    }

    /**
     * Session-scoped attachment access for the `view_attachment` tool: a
     * reference is resolved against the attachments recorded on this
     * session's own messages (never an arbitrary media id), then downloaded
     * and routed exactly like a fresh turn would for `model`.
     */
    private async attachmentViewSurface(input: {
      sessionId: string;
      roomId: string | undefined;
      model: string;
      ambientLlm: LlmAdapter;
      platform: OpenRouterLlmAdapter;
      signal: AbortSignal;
    }): Promise<AttachmentViewSurface> {
      const saver = this.saver!;
      const offloaded = await saver.hasThreadMessageMatching(input.sessionId, {
        messageType: 'human',
        contentContains: ATTACHMENT_PLACEHOLDER_PREFIX,
      });
      const findMeta = async (ref: string) => {
        // The placeholder quotes the ref, so a cheap pre-filter usually
        // finds the message; a still-inline attachment needs the full scan.
        const candidates = await saver.listThreadMessagesMatching(
          input.sessionId,
          { messageType: 'human', contentContains: ref },
        );
        const scan =
          candidates.length > 0
            ? candidates
            : await saver.listThreadMessages(input.sessionId);
        return scan
          .filter((m) => m.type === 'human')
          .flatMap((m) => attachmentMetas(m))
          .find((meta) => attachmentRef(meta) === ref);
      };
      return {
        offloaded,
        view: async (ref) => {
          const meta = await findMeta(ref);
          if (!meta) {
            throw new Error(
              `no attachment with ref "${ref}" in this conversation`,
            );
          }
          const view = await viewAttachment(meta, {
            source: this.matrixMediaSource(),
            extraction: this.extractionProvider(
              input.ambientLlm,
              input.platform,
            ),
            caps: getModelCapabilities(input.model),
            roomId: input.roomId,
            signal: input.signal,
            logger: console,
          });
          return { meta, view };
        },
      };
    }

    /**
     * Attachment payload retention (`src/attachments/retention.ts`), run
     * once a turn has completed and its checkpoints are written: inline
     * payloads older than the newest `ATTACHMENT_PAYLOAD_TURNS` user turns
     * are rewritten in place in the messages table — the rows the next turn
     * loads, so the model sees the placeholder and the bytes leave the
     * database. Rows the graph state no longer references (summarised away)
     * are older than any retained turn and are rewritten too. Idempotent:
     * a rewritten row holds no inline block and is never selected again.
     */
    private async retainAttachmentPayloads(
      sessionId: string,
      stateMessages: BaseMessage[],
    ): Promise<void> {
      // Nothing captured (an interrupted stream): never offload blindly.
      if (stateMessages.length === 0) return;
      const saver = this.saver!;
      const { retainedIds, rewrites } = applyAttachmentRetention(
        stateMessages,
        ATTACHMENT_PAYLOAD_TURNS,
      );
      const pending = new Set(rewrites.map((m) => m.id));
      const stale = await saver.listThreadMessagesMatching(sessionId, {
        messageType: 'human',
        contentContains: INLINE_PAYLOAD_NEEDLE,
      });
      for (const row of stale) {
        if (!row.id || retainedIds.has(row.id) || pending.has(row.id)) continue;
        const rewritten = offloadInlinePayloads(row);
        if (rewritten) rewrites.push(rewritten);
      }
      let replaced = 0;
      for (const message of rewrites) {
        if (await saver.replaceThreadMessage(sessionId, message)) replaced += 1;
      }
      if (replaced > 0) {
        console.log(
          `[user-do] attachments: offloaded the inline payload of ${replaced} message(s) in ${sessionId}`,
        );
      }
    }

    /**
     * The helper-model provider for attachment extraction: the PLATFORM
     * adapter's config + its `vision` role, never a BYO credential (Node wires
     * `FileProcessingService` the same way).
     */
    private extractionProvider(
      ambientLlm: LlmAdapter,
      platform: OpenRouterLlmAdapter,
    ): {
      baseURL: string;
      apiKey: string;
      headers: Record<string, string>;
      model: string;
    } | null {
      const adapter = isProviderAdapter(ambientLlm) ? ambientLlm : platform;
      if (!adapter.providerConfig.apiKey) return null;
      return {
        ...adapter.providerConfig,
        model: adapter.modelForRole('vision'),
      };
    }

    /**
     * Sandbox archive target for this user's attachments — a UCAN minted from
     * their delegation for `SANDBOX_MCP_URL`, or null when either is missing
     * (originals are then not archived; the turn still runs).
     */
    private async sandboxArchiveConfig(
      userDid: string,
    ): Promise<SandboxUploadConfig | null> {
      const sandboxMcpUrl = this.env.SANDBOX_MCP_URL;
      if (typeof sandboxMcpUrl !== 'string' || sandboxMcpUrl.length === 0)
        return null;
      const delegation = this.delegations.get(userDid);
      if (!delegation?.raw || !this.ucan) return null;
      const minted = await this.ucan.createInvocationFromDelegation(
        delegation.raw,
        sandboxMcpUrl,
        { can: '*', with: 'ixo:sandbox' },
      );
      if ('error' in minted) {
        console.warn(
          `[user-do] attachments: cannot archive to the sandbox for ${userDid}: ${minted.error}`,
        );
        return null;
      }
      return {
        sandboxMcpUrl,
        authHeaders: {
          Authorization: `Bearer ${minted.invocation}`,
          'X-Auth-Type': 'ucan',
        },
      };
    }

    private async prepareTurn(
      req: TurnRequest,
      body: Pick<
        TurnBody,
        'message' | 'timezone' | 'model' | 'tools' | 'agActions' | 'attachments'
      >,
    ) {
      const core = this.core;
      const baseAmbient = this.ambient!;
      const saver = this.saver!;
      const sessions = this.sessions!;

      // Per-request model override, resolved BEFORE the agent build because
      // the BYO leg needs it. Platform ids are gated by the catalog
      // allow-list; `byo:` ids are validated (and bound to a connected
      // credential) inside `resolveForTurn`. An unknown id is dropped and
      // the turn falls back to the default model. (Mirrors the Node
      // runtime's AgentBuilder.)
      let requestedModel: string | undefined;
      let requestedByoModel: string | undefined;
      if (body.model) {
        if (isByoModelId(body.model)) {
          requestedByoModel = body.model;
        } else if (isAllowedModel(body.model)) {
          requestedModel = body.model;
        } else {
          console.warn(
            `[user-do] ignoring unknown model "${body.model}" — falling back to the default model.`,
          );
        }
      }

      // BYO credential resolution. An explicit *platform* model choice keeps
      // the turn platform-paid, so the lookup is skipped entirely; a `byo:`
      // choice (or no choice at all — the Matrix ingress) resolves the
      // user's connected credential. No-ops to null when BYO_LLM_ENABLED is
      // off. Best-effort: a resolution failure degrades to a platform turn.
      let byoNotice: Record<string, unknown> | undefined;
      const noteFallback = (notice: Record<string, unknown>): void => {
        byoNotice = notice;
      };
      let byoTurn: ByoTurnState | null = null;
      if (requestedModel === undefined && this.byo) {
        byoTurn = await this.byo
          .resolveForTurn({
            userDid: req.identity.userDid,
            requestedModel: requestedByoModel,
            onNotice: (notice) => noteFallback({ ...notice }),
          })
          .catch((err: unknown): ByoTurnState | null => {
            console.warn(
              `[user-do] BYO credential resolution failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            noteFallback({ ...buildByoFallbackNotice('error') });
            return null;
          });
      }
      if (byoTurn) {
        console.log(
          `[user-do] BYO turn — provider=${byoTurn.provider}, model=${byoTurn.mainModelId}, did=${req.identity.userDid}`,
        );
      }
      // On a BYO turn the swapped adapter serves every role the provider
      // covers, so the whole turn runs on the user's credential; the
      // credential lives only in the adapter's closure.
      const ambient: AmbientServices = byoTurn
        ? {
            ...baseAmbient,
            llm: createByoLlmAdapter(
              baseAmbient.llm,
              {
                credential: byoTurn.credential,
                mainModelId: byoTurn.mainModelId,
                chatGptBackend: byoTurn.chatGptBackend,
              },
              console,
            ),
          }
        : baseAmbient;
      const effectiveModel = byoTurn ? byoTurn.byoModelId : requestedModel;
      if (
        req.client === 'matrix' &&
        !(await sessions.getSession(req.sessionId))
      ) {
        await sessions.createSession({
          sessionId: req.sessionId,
          roomId: req.roomId,
          oracleName: core.identity.name,
          oracleDid: this.env.ORACLE_DID,
          oracleEntityDid: core.identity.entityDid,
        });
      }
      this.aborts.get(req.sessionId)?.abort();
      const abortController = new AbortController();
      this.aborts.set(req.sessionId, abortController);

      // Every turn runs inside the user's oracle room, like the Node
      // runtime's request preparer: plugins key per-room state on it and the
      // memory engine rejects calls that carry no `x-room-id` (as a generic
      // "invalid token"). Matrix-ingress turns bring the room; HTTP turns
      // take it from the session row or resolve the user↔oracle room alias.
      const sessionRoomId =
        req.roomId ??
        (await sessions.getSession(req.sessionId))?.roomId ??
        (
          await this.gateway
            .resolveUserRoom(req.identity.userDid)
            .catch(() => null)
        )?.roomId;
      if (!sessionRoomId) {
        console.warn(
          `[user-do] no oracle room resolved for ${req.identity.userDid}; room-scoped plugins (memory) will be unavailable this turn`,
        );
      }
      if (sessionRoomId) this.sessionRooms.set(req.sessionId, sessionRoomId);

      // A Matrix turn with no usable delegation: ask the web app to open its
      // "authorize for Matrix" modal (throttled per user, best-effort) — the
      // Node AgentBuilder's `maybePromptReauth`.
      if (
        req.client === 'matrix' &&
        sessionRoomId &&
        !this.delegations.get(req.identity.userDid)?.raw
      ) {
        this.promptReauth(req.identity.userDid, sessionRoomId);
      }

      // Per-room user preferences (tone, language, what to call whom) —
      // hydrated BEFORE the agent is built so the system prompt sees them
      // on turn 1, exactly like the Node AgentBuilder. Best-effort: a
      // preferences read failure never fails the turn.
      const userPreferences =
        sessionRoomId && this.preferences
          ? await this.preferences.get(sessionRoomId).catch((err: unknown) => {
              console.warn(
                `[user-do] could not load user preferences for ${sessionRoomId}: ${err instanceof Error ? err.message : String(err)}`,
              );
              return undefined;
            })
          : undefined;

      // Attachments — the Node MessagesService contract: route by the model's
      // native capabilities, send images/files inline when it reads them,
      // otherwise the `vision` role turns them into text on the platform key;
      // originals are archived to the user's sandbox when one is reachable.
      const attachmentInputs = parseAttachmentInputs(
        body.attachments ?? req.attachments,
      );
      const attachmentModel =
        effectiveModel && isAllowedModel(effectiveModel)
          ? effectiveModel
          : getDefaultModelId(core.validatedEnv);
      const prepared =
        attachmentInputs.length > 0
          ? await prepareAttachments(
              {
                text: body.message,
                attachments: attachmentInputs,
                roomId: sessionRoomId,
                model: attachmentModel,
                caps: getModelCapabilities(attachmentModel),
              },
              {
                source: this.matrixMediaSource(),
                extraction: this.extractionProvider(baseAmbient.llm, core.llm),
                sandbox: await this.sandboxArchiveConfig(req.identity.userDid),
                signal: abortController.signal,
                logger: console,
              },
            )
          : null;
      if (prepared) {
        console.log(
          `[user-do] attachments: ${attachmentInputs.length} attached, ${prepared.extracted.length} extracted, ${Array.isArray(prepared.content) ? prepared.content.length - 1 : 0} native`,
        );
      }

      // `view_attachment` for this session: payloads older than the newest
      // `ATTACHMENT_PAYLOAD_TURNS` user turns are placeholders by now (see
      // `retainAttachmentPayloads`); the tool fetches one again on demand.
      // Cleanups registered by tools for THIS turn (MCP clients …): run once
      // the turn ends, however it ends — see `RuntimeContext.onTurnEnd`.
      const turnDisposables = new Set<() => void | Promise<void>>();
      abortController.signal.addEventListener('abort', () => {
        void this.runTurnDisposables(turnDisposables);
      });
      const attachmentAccess = await this.attachmentViewSurface({
        sessionId: req.sessionId,
        roomId: sessionRoomId,
        model: attachmentModel,
        ambientLlm: baseAmbient.llm,
        platform: core.llm,
        signal: abortController.signal,
      });

      const existing = await saver.getTupleWithoutMessages({
        configurable: { thread_id: req.sessionId },
      });
      const priorState = existing?.checkpoint.channel_values ?? {};
      // Request metadata (editor room, space, session run, entity) → state,
      // by the Node agent-builder's rules (see turn-metadata.ts).
      const meta = parseTurnMetadata(req.metadata);
      const priorMeta = priorMetadataState(priorState);

      // Host page-context / safety-guardrail hooks, resolved against this
      // object's ambient services (see `OracleWorkerHooks`).
      const hostRoomTitle = opts.hooks?.getRoomTitle;
      const hostSafetyModel = opts.hooks?.safetyModel;

      const { agent, context } = await createMainAgent({
        registries: core.registries,
        identity: core.identity,
        config: core.validatedEnv,
        availablePlugins: core.availablePlugins,
        byoProvider: byoTurn?.provider,
        ambient: {
          ...ambient,
          attachments: attachmentAccess,
          onTurnEnd: (dispose) => turnDisposables.add(dispose),
        },
        hooks: {
          // Drives the Matrix `work_status` card (one step per model/tool
          // call); a no-op for turns that registered no card (HTTP, tasks).
          middlewares: this.workStatus
            ? [createWorkStatusMiddleware({ producer: this.workStatus })]
            : [],
          ...(hostRoomTitle
            ? {
                getRoomTitle: (roomId: string) =>
                  hostRoomTitle(roomId, ambient),
              }
            : {}),
          ...(hostSafetyModel ? { safetyModel: hostSafetyModel(ambient) } : {}),
        },
        requestCtx: {
          user: {
            did: req.identity.userDid,
            matrixUserId:
              req.identity.matrixUserId ??
              (await this.resolveMatrixUserId(req.identity.userDid)) ??
              '',
            ucanDelegation: { raw: req.identity.ucanDelegation ?? '' },
            timezone: req.identity.timezone,
            currentTime: new Date().toISOString(),
          },
          session: {
            id: req.sessionId,
            client: req.client,
            requestId: req.requestId,
            roomId: sessionRoomId,
          },
          model: effectiveModel,
        },
        state: {
          ...priorState,
          userPreferences,
          ...metadataBuildState(meta, priorMeta),
          // The client-declared surface of THIS request: the portal and
          // AG-UI plugins turn these into tools at build time
          // (`getRequestTools` reads `history.state`), so they must be here
          // and not only in the graph input.
          browserTools: body.tools ?? [],
          agActions: body.agActions ?? [],
        },
        checkpointer: saver,
        abortSignal: abortController.signal,
      });

      const attachmentKwargs =
        prepared && prepared.metas.length > 0
          ? { attachment: prepared.metas[0], attachments: prepared.metas }
          : {};
      const stateInput = {
        messages: [
          new HumanMessage({
            content: prepared ? prepared.content : body.message,
            additional_kwargs: {
              timestamp: new Date().toISOString(),
              oracleName: core.identity.name,
              msgFromMatrixRoom: req.client === 'matrix',
              ...attachmentKwargs,
            },
          }),
          // Extraction-lane text rides as hidden context messages (the
          // transcript hides AI messages that carry an `attachment`), as on Node.
          ...(prepared?.extracted ?? []).map(
            (item) =>
              new AIMessage({
                content: item.text,
                additional_kwargs: {
                  msgFromMatrixRoom: req.client === 'matrix',
                  timestamp: new Date().toISOString(),
                  attachment: item.meta,
                },
              }),
          ),
        ],
        config: { did: req.identity.userDid },
        client: req.client,
        ...metadataGraphInput(meta, priorMeta),
        browserTools: body.tools ?? [],
        agActions: body.agActions ?? [],
      };
      // LangSmith: metadata is attached unconditionally (inert without a
      // tracer); the explicit tracer only when this turn is traced (global
      // switch or per-DID allowlist — see `resolveLangsmithTracing`).
      const tracing = resolveLangsmithTracing({
        userDid: req.identity.userDid,
        client: req.client,
        env: langsmithEnvFromWorkerEnv(this.env),
      });

      const config = {
        configurable: { thread_id: req.sessionId },
        context,
        signal: abortController.signal,
        recursionLimit: turnRecursionLimit(this.env),
        metadata: tracing.metadata,
        ...(tracing.callbacks ? { callbacks: tracing.callbacks } : {}),
      };
      return {
        agent,
        stateInput,
        config,
        abortController,
        byoNotice,
        byoProvider: byoTurn?.provider,
        turnDisposables,
      };
    }

    /**
     * Node parity (`MessagesService.sendMessage`): every HTTP/SSE turn is
     * replayed into the user's oracle room as a thread under the session's
     * root event — the user's message as `**You:**`, the reply as the
     * oracle. Fire-and-forget, exactly as on Node: the turn never waits on
     * Matrix, a failure is logged. Room-originated turns are answered in the
     * room by the gateway, and synthetic task sessions have no root event.
     */
    private replayToRoom(
      req: TurnRequest,
      text: string,
      who: 'user' | 'oracle',
    ): void {
      if (req.client === 'matrix') return;
      if (req.sessionId.startsWith(SYNTHETIC_SESSION_PREFIX)) return;
      // A local session id has no marker event to thread on: the user had
      // no oracle room when the session was created, so there is no room
      // transcript to mirror either.
      if (!req.sessionId.startsWith('$')) return;
      if (!text.trim()) return;
      const label = who === 'user' ? 'user message' : 'AI response';
      // Serialised per session, retried across a gateway restart with a fixed
      // transaction id, kept alive past the request (room-mirror.ts).
      void this.roomMirror().enqueue(
        req.sessionId,
        async () => {
          const roomId =
            this.sessionRooms.get(req.sessionId) ??
            req.roomId ??
            (await this.sessions?.getSession(req.sessionId))?.roomId ??
            (
              await retryGateway(() =>
                this.gateway.resolveUserRoom(req.identity.userDid),
              )
            )?.roomId;
          if (!roomId) throw new Error('no oracle room for this user');
          this.sessionRooms.set(req.sessionId, roomId);
          const { body, formattedBody } = formatReplay({
            message: text,
            isOracle: who === 'oracle',
            oracleName: this.core.identity.name,
          });
          return {
            roomId,
            body,
            ...(formattedBody ? { formattedBody } : {}),
            threadId: req.sessionId,
            txnId: mirrorTxnId(req.sessionId, req.requestId, who),
          };
        },
        label,
      );
    }

    private roomMirror(): RoomMirror {
      this.mirror ??= new RoomMirror({
        sendText: (send) =>
          this.gateway.sendText(send.roomId, send.body, {
            threadId: send.threadId,
            ...(send.formattedBody
              ? { formattedBody: send.formattedBody }
              : {}),
            priority: 'background',
            txnId: send.txnId,
          }),
        keepAlive: (work) => this.ctx.waitUntil(work),
        log: (message) => console.log(message),
        warn: (message) => console.warn(message),
      });
      return this.mirror;
    }

    private async afterTurn(
      sessionId: string,
      messages: BaseMessage[],
    ): Promise<void> {
      const sessions = this.sessions!;
      await sessions.touchSession(sessionId);
      await this.retainAttachmentPayloads(sessionId, messages).catch(
        (err: unknown) => {
          console.warn(
            `[user-do] attachment payload retention failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        },
      );
      const row = await sessions.getSession(sessionId);
      if (row && (!row.title || row.title === UNTITLED_SESSION)) {
        const title = await this.generateTitle(messages).catch(() => null);
        if (title)
          await sessions.setTitle(sessionId, title, { onlyIfUntitled: true });
      }
      this.markDirty();
    }

    private async generateTitle(
      messages: BaseMessage[],
    ): Promise<string | null> {
      const human = messages.find((m) => m.type === 'human');
      const ai = [...messages].reverse().find((m) => m.type === 'ai');
      if (!human) return null;
      // The ambient adapter honours LLM_PROVIDER; fall back to the core's
      // OpenRouter adapter if boot has not built the ambient bag yet.
      const model = (this.ambient?.llm ?? this.core.llm).get('session-title');
      const prompt =
        'Write a 3–6 word title for this conversation. Reply with the title only, no quotes.\n\n' +
        `User: ${contentToText(human.content).slice(0, 500)}\n` +
        (ai ? `Assistant: ${contentToText(ai.content).slice(0, 500)}` : '');
      const res = await model.invoke(prompt);
      const title = contentToText(res.content)
        .trim()
        .replace(/^["']|["']$/g, '')
        .slice(0, 80);
      return title || null;
    }
  };
}

/**
 * Durable KV for the BYO service over this object's storage: device-auth
 * bindings and unpersisted rotated ChatGPT tokens must survive object
 * eviction. TTLs are stored inline and enforced on read.
 */
function createByoStateStore(storage: DurableObjectStorage): ByoStateStore {
  const keyOf = (key: string): string => `byo:${key}`;
  return {
    async get(key) {
      const hit = await storage.get<{ value: string; expiresAt?: number }>(
        keyOf(key),
      );
      if (!hit) return undefined;
      if (hit.expiresAt !== undefined && hit.expiresAt <= Date.now()) {
        await storage.delete(keyOf(key));
        return undefined;
      }
      return hit.value;
    },
    async put(key, value, ttlMs) {
      await storage.put(keyOf(key), {
        value,
        ...(ttlMs !== undefined ? { expiresAt: Date.now() + ttlMs } : {}),
      });
    },
    async delete(key) {
      await storage.delete(keyOf(key));
    },
  };
}

/** Pass LangGraph events through untouched while recording the final message list. */
async function* tapMessages(
  events: AsyncIterable<unknown>,
  capture: BaseMessage[],
): AsyncIterable<unknown> {
  for await (const evt of events) {
    const e = evt as {
      event?: string;
      data?: { output?: { messages?: BaseMessage[] } };
    };
    if (e.event === 'on_chain_end' && Array.isArray(e.data?.output?.messages)) {
      capture.splice(0, capture.length, ...e.data.output.messages);
    }
    yield evt;
  }
}

/**
 * Merge the turn's SSE stream with plugin-emitted events. Plugin events are
 * written straight into the same byte stream as they happen.
 */
function mergeWithEmitter(
  base: ReadableStream<Uint8Array>,
  onRegister: (write: (eventName: string, payload: unknown) => void) => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let closed = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      onRegister((eventName, payload) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(formatSSE(eventName, payload)));
        } catch {
          closed = true;
        }
      });
      const reader = base.getReader();
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!closed) controller.enqueue(value);
          }
        } catch (err) {
          if (!closed) controller.error(err);
        } finally {
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      })();
    },
    cancel() {
      closed = true;
      void base.cancel();
    },
  });
}

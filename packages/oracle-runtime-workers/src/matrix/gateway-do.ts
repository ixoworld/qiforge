/**
 * Matrix gateway Durable Object — one per oracle, home of the bot identity.
 *
 * Built on `@ixo/matrix-bot-workers-sdk`'s `MatrixBotDO`, which owns
 * everything generic about running an E2EE Matrix bot on Workers: password
 * login and the device identity, the crypto store persisted to DO storage,
 * the sync loop and its keep-alive alarm, paced durable sends (per-room
 * FIFOs, token bucket, outbox with poison-row eviction), resumable catch-up
 * after a restart, invite handling, the idle recycle and device rotation.
 *
 * This subclass adds only what is specific to the oracle:
 *
 *  - inbound room messages → user-object turns (`IngestPipeline` for the
 *    per-session debounce, thread / quote-reply resolution, attachments,
 *    typing, the work-status card);
 *  - user↔oracle room resolution from DIDs (alias on the user's homeserver);
 *  - dedicated task rooms;
 *  - user SQLite snapshots as encrypted room media (`m.ixo.media_*`);
 *  - the oracle's P-256 secrets key from its account room;
 *  - a second, crypto-less password device for plugins that need a raw
 *    matrix-js-sdk client (editor, flows).
 */
import {
  listPendingSends,
  MatrixBotDO,
  optionsFromEnv,
  Semaphore,
  withRateLimitRetry,
  type BotMessage,
  type BotTimelineEvent,
  type MatrixBotOptions,
  type StartResult,
} from '@ixo/matrix-bot-workers-sdk';
import { createClient, MatrixError, Preset, Visibility } from 'matrix-js-sdk';
import {
  userObjectName,
  userOracleRoomAlias,
  type BotCredentials,
  type CreateRoomOptions,
  type GatewayStatus,
  type GroupRoomInfo,
  type JsonString,
  type MatrixGatewayObject,
  type OracleWorkerEnv,
  type OutboxRow,
  type TurnResult,
  type UserOracleObject,
  type MediaStream,
  type SnapshotStream,
  isInterruptedTurnError,
} from '../do/contracts';
import { decryptWithPin } from '../secrets/pin-cipher';
import {
  encryptedMnemonicOf,
  parseSigningMnemonic,
  SIGNING_MNEMONIC_STATE_KEY,
  SIGNING_MNEMONIC_STATE_TYPE,
} from '../secrets/signing-mnemonic';
import {
  attributeUser,
  IngestPipeline,
  userDidFromRoomAlias,
  type InboundAttachment,
  type IngestTurn,
  type InboundMessage,
} from './ingest';
import {
  bumpInboxAttempts,
  countInboxRows,
  deleteInboxRows,
  ensureInboxTable,
  inboundOfRow,
  type InboxRow,
  insertInboxRow,
  listInboxRows,
  MAX_TURN_REPLAYS,
  planInboxReplay,
  replyTxnId,
  updateInboxThread,
} from './inbox-store';
import {
  type GateDecision,
  GroupChatService,
  groupChatOptionsFromEnv,
  isBotMentioned,
} from './group-chat';
import {
  inReplyToOf,
  type MatrixRelatesTo,
  readRelatesTo,
  resolveReplyChainRoot,
  ThreadRootCache,
} from './reply-chain';
import { fetchUserMatrixServerName } from './user-homeserver';

const TYPING_REFRESH_MS = 20_000;
const TYPING_TIMEOUT_MS = 30_000;
/** User DID → room id memo (aliases never move; a miss re-resolves). */
const ALIAS_CACHE_TTL_MS = 30 * 60_000;
/** User DID → Matrix server name (from the DID document via Blocksync). */
const HOMESERVER_CACHE_TTL_MS = 6 * 60 * 60_000;
/**
 * A room created by a user seconds ago may not have delivered its invite
 * through sync yet when the user's object asks for its state; within this
 * window a 403 is answered by accepting the invite and reading again.
 */
const PENDING_INVITE_GRACE_MS = 5_000;
/** Room turns in flight at once (each ends in an encrypted reply). */
const DEFAULT_TURN_CONCURRENCY = 4;
/** Idle recycle of the object after this many sends (0 disables). */
const DEFAULT_RECYCLE_AFTER_SENDS = 300;
const LOGIN_RETRY_ATTEMPTS = 3;
const LOGIN_RETRY_MAX_MS = 30_000;

/** State event (keyed by storageKey) naming the live media event of a user snapshot. */
const MEDIA_STATE_TYPE = 'm.ixo.media_state';
/** Timeline event carrying the snapshot bytes (encrypted in E2EE rooms). */
const MEDIA_UPLOAD_TYPE = 'm.ixo.media_upload';
const SNAPSHOT_MIMETYPE = 'application/x-sqlite3';

/** Media msgtypes the ingest turns into attachments (the Node bridge's set). */
const FILE_MSGTYPES = new Set<string>([
  'm.file',
  'm.image',
  'm.video',
  'm.audio',
]);

/** Storage key of the plugins' (crypto-less) device — see `botCredentials`. */
const BOT_CLIENT_IDENTITY_KEY = 'identity:bot-client';

interface OracleGatewayConfig {
  baseUrl: string;
  userId: string;
  password: string;
  recoveryPassphrase?: string;
  /** Server name used for user↔oracle room aliases when the user's DID names none. */
  serverName: string;
  /** The oracle's chain (account) DID — Durable-Object routing of user objects. */
  oracleDid: string;
  /**
   * The DID that forms the oracle half of the user↔oracle room alias
   * (`#<userDidDashed>_<oracleRoomDidDashed>:server`). The Node runtime builds
   * this alias from the oracle's ENTITY DID, not its account DID, so a Workers
   * oracle whose `ORACLE_ENTITY_DID` differs from `ORACLE_DID` must resolve the
   * SAME room to read a migrating user's media. Falls back to `oracleDid` when
   * no entity DID is configured (e.g. the local harness, where they are equal).
   */
  oracleRoomDid: string;
}

/** The plugins' device credentials as stored (`identity:bot-client`). */
interface StoredDevice {
  userId: string;
  deviceId: string;
  accessToken: string;
}

interface AliasCacheEntry {
  roomId: string;
  alias: string;
  at: number;
}

interface HomeserverCacheEntry {
  serverName: string;
  at: number;
}

function gateSizeFromEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || /\babort(ed)?\b/i.test(err.message))
  );
}

function isForbidden(err: unknown): boolean {
  return (
    err instanceof MatrixError &&
    (err.errcode === 'M_FORBIDDEN' || err.httpStatus === 403)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `info.mimetype` / `info.size` of a media message when well-formed. */
function readMediaInfo(content: Record<string, unknown>): {
  mimetype?: string;
  size?: number;
} {
  const info: unknown = content['info'];
  if (typeof info !== 'object' || info === null) return {};
  const rec: Record<string, unknown> = { ...info };
  return {
    ...(typeof rec['mimetype'] === 'string'
      ? { mimetype: rec['mimetype'] }
      : {}),
    ...(typeof rec['size'] === 'number' ? { size: rec['size'] } : {}),
  };
}

/** The `eventId` a `m.ixo.media_state` event points at, when set. */
/** `content` of a room event fetched as JSON (undefined when the shape is off). */
function eventContentOf(json: JsonString): unknown {
  const parsed: unknown = JSON.parse(json);
  return typeof parsed === 'object' && parsed !== null && 'content' in parsed
    ? parsed.content
    : undefined;
}

function stateEventId(json: JsonString | null): string | undefined {
  if (!json) return undefined;
  const parsed: unknown = JSON.parse(json);
  return typeof parsed === 'object' &&
    parsed !== null &&
    'eventId' in parsed &&
    typeof parsed.eventId === 'string' &&
    parsed.eventId
    ? parsed.eventId
    : undefined;
}

// ---------------------------------------------------------------------------
// Durable Object
// ---------------------------------------------------------------------------

/** Posted when a room turn fails or is given up; the user resends. */
const TURN_FAILED_NOTICE =
  'Sorry — something went wrong while handling your message. Please try again.';

export class MatrixGatewayDO
  extends MatrixBotDO<OracleWorkerEnv>
  implements MatrixGatewayObject
{
  private config: OracleGatewayConfig | null = null;
  private ingest: IngestPipeline | null = null;
  /** `m.room.canonical_alias` per room (null = none), read once per instance. */
  private readonly roomAliases = new Map<string, string | null>();
  /**
   * User DID → registered Matrix server name (lowercased), refreshed before
   * every offer from `userServerName` so the pipeline can check it synchronously.
   */
  private readonly userServers = new Map<string, string>();
  /** Quote-reply chain → thread root memo (see reply-chain.ts). */
  private readonly threadRoots = new ThreadRootCache();
  private readonly turnGate = new Semaphore(
    gateSizeFromEnv(this.env.MATRIX_TURN_CONCURRENCY, DEFAULT_TURN_CONCURRENCY),
  );
  private pluginDevice: BotCredentials | null = null;
  /** Memoised `getOracleSecretsKey` result (private JWK JSON). */
  private oracleSecretsKeyJson: string | null = null;
  private oracleSigningMnemonic: string | null = null;
  private inboxTableReady = false;
  /** Event ids of turns running in this instance (a graceful restart must not replay them). */
  private readonly inFlightEvents = new Set<string>();
  private inboxReplayRunning = false;
  /** Group rooms: the gate and the per-room channel memory (see group-chat.ts). */
  private groupChatService: GroupChatService | null = null;

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  private cfg(): OracleGatewayConfig {
    if (this.config) return this.config;
    const env = this.env;
    const baseUrl = env.MATRIX_BASE_URL;
    const userId = env.MATRIX_ORACLE_ADMIN_USER_ID;
    if (!baseUrl || !userId)
      throw new Error(
        'MatrixGatewayDO: MATRIX_BASE_URL and MATRIX_ORACLE_ADMIN_USER_ID are required',
      );
    if (!env.ORACLE_DID)
      throw new Error('MatrixGatewayDO: ORACLE_DID is required');
    const password = env.MATRIX_ORACLE_ADMIN_PASSWORD;
    if (!password)
      throw new Error(
        'MatrixGatewayDO: MATRIX_ORACLE_ADMIN_PASSWORD is required — the gateway logs its own device in with it',
      );
    const phrase = env.MATRIX_RECOVERY_PHRASE;
    this.config = {
      baseUrl: baseUrl.replace(/\/+$/, ''),
      userId,
      password,
      // The infra chart ships the literal placeholder `secret` when no
      // passphrase was provisioned.
      ...(phrase && phrase !== 'secret' ? { recoveryPassphrase: phrase } : {}),
      serverName:
        env.MATRIX_HOMESERVER_NAME || userId.slice(userId.indexOf(':') + 1),
      oracleDid: env.ORACLE_DID,
      oracleRoomDid: env.ORACLE_ENTITY_DID || env.ORACLE_DID,
    };
    return this.config;
  }

  protected override async resolveOptions(): Promise<MatrixBotOptions> {
    const cfg = this.cfg();
    const env = this.env;
    const options = optionsFromEnv({
      MATRIX_HOMESERVER_URL: cfg.baseUrl,
      MATRIX_USER_ID: cfg.userId,
      MATRIX_PASSWORD: cfg.password,
      MATRIX_DEVICE_DISPLAY_NAME: `QiForge oracle (${env.ORACLE_NAME ?? 'workers'})`,
      MATRIX_RECOVERY_PASSPHRASE: cfg.recoveryPassphrase,
      MATRIX_SEND_RATE_PER_SECOND: env.MATRIX_SEND_RATE_PER_SECOND,
      MATRIX_SEND_BURST: env.MATRIX_SEND_BURST,
      MATRIX_SEND_CONCURRENCY: env.MATRIX_SEND_CONCURRENCY,
      MATRIX_RECYCLE_AFTER_SENDS:
        env.MATRIX_RECYCLE_AFTER_SENDS ?? String(DEFAULT_RECYCLE_AFTER_SENDS),
      MATRIX_HOT_ROOMS: env.MATRIX_HOT_ROOMS,
      MATRIX_BACKFILL_MAX_EVENTS: env.MATRIX_BACKFILL_MAX_EVENTS,
      // Memory guards (SDK 0.5+): byte-capped /sync and catch-up pages and
      // an optional ciphertext cap on decryption. Unset = the SDK defaults.
      MATRIX_SYNC_TIMELINE_LIMIT: env.MATRIX_SYNC_TIMELINE_LIMIT,
      MATRIX_SYNC_BYTES_CAP: env.MATRIX_SYNC_BYTES_CAP,
      MATRIX_CATCHUP_PAGE_SIZE: env.MATRIX_CATCHUP_PAGE_SIZE,
      MATRIX_PAGE_BYTES_CAP: env.MATRIX_PAGE_BYTES_CAP,
      MATRIX_MAX_DECRYPT_BYTES: env.MATRIX_MAX_DECRYPT_BYTES,
      // Opt-in bulk restore of the key backup on a device's first start
      // (SDK 0.6+); off by default — the gateway fetches room keys from the
      // backup on demand, one session at a time.
      MATRIX_BACKUP_BULK_RESTORE: env.MATRIX_BACKUP_BULK_RESTORE,
      MATRIX_BACKUP_BULK_RESTORE_MAX_KEYS:
        env.MATRIX_BACKUP_BULK_RESTORE_MAX_KEYS,
      // Keep-alive fuse (SDK 0.7+): the alarm is re-armed a few seconds
      // ahead while the object works, so a host drain brings it back within
      // the fuse instead of at the next cycle.
      MATRIX_KEEPALIVE_FUSE_MS: env.MATRIX_KEEPALIVE_FUSE_MS,
      LOG_LEVEL: env.LOG_LEVEL,
    });
    return {
      ...options,
      // The SDK delivers every message at once; the per-session debounce that
      // merges a burst into one turn is the ingest pipeline's (Node parity).
      messageDebounceMs: 0,
    };
  }

  // -------------------------------------------------------------------------
  // Inbound: room messages → user-object turns
  // -------------------------------------------------------------------------

  private ingestPipeline(): IngestPipeline {
    if (this.ingest) return this.ingest;
    const cfg = this.cfg();
    this.ingest = new IngestPipeline({
      oracleDid: cfg.oracleRoomDid,
      botUserId: cfg.userId,
      canonicalAlias: (roomId) => this.roomAliases.get(roomId) ?? null,
      userServerName: (userDid) => this.userServers.get(userDid) ?? null,
      dispatch: (turn) => this.dispatchTurn(turn),
      onError: (err, context) =>
        this.log('error', `ingest failed (${context})`, err),
    });
    return this.ingest;
  }

  protected override async onMessage(message: BotMessage): Promise<void> {
    // `messageDebounceMs` is 0, so every delivery carries exactly one event.
    const eventId = message.eventIds[0];
    if (!eventId) return;
    const content = message.content;
    if ('INTERNAL' in content) return; // Node-runtime bookkeeping events
    const isText = message.msgtype === 'm.text';
    const isFile = FILE_MSGTYPES.has(message.msgtype);
    if (!isText && !isFile) return;
    const inbound: InboundMessage = {
      eventId,
      roomId: message.roomId,
      sender: message.sender,
      ts: message.ts,
      body: isText ? message.body : '',
      ...(message.threadRootId ? { threadRootId: message.threadRootId } : {}),
      ...(isFile
        ? { attachment: attachmentOf(content, eventId, message.body) }
        : {}),
      ...(isBotMentioned(content, this.cfg().userId)
        ? { mentionsBot: true }
        : {}),
      ...(() => {
        const target = inReplyToOf(readRelatesTo(content));
        return target ? { inReplyTo: target } : {};
      })(),
    };
    // Durable before anything waits on the network: the SDK has already
    // marked the event processed, so from here on only this row brings the
    // message back if the instance dies before its reply is in the outbox.
    const sql = this.inboxSql();
    insertInboxRow(sql, inbound, Date.now());
    // Resolved before the offer so the pipeline's synchronous lookups (room
    // alias → user DID, user DID → registered homeserver) answer from memos.
    await this.canonicalAliasOf(message.roomId);
    await this.resolveSenderServer(inbound);
    const threadRootId = await this.threadRootFor(
      eventId,
      message.roomId,
      readRelatesTo(message.content),
      message.threadRootId,
    );
    if (threadRootId !== inbound.threadRootId) {
      inbound.threadRootId = threadRootId;
      updateInboxThread(sql, eventId, threadRootId);
    }
    this.offerInbound(inbound);
  }

  /** Feed a message into the ingest pipeline; a message it will not turn into a turn leaves the inbox at once. */
  private offerInbound(inbound: InboundMessage): void {
    const outcome = this.ingestPipeline().offer(inbound);
    if (outcome !== 'queued') {
      deleteInboxRows(this.inboxSql(), [inbound.eventId]);
      this.log(
        // A DID-shaped identity from a server that is not the DID's own is
        // someone presenting a DID they do not control.
        outcome === 'foreign' ? 'warn' : 'debug',
        `ingest dropped ${inbound.eventId} in ${inbound.roomId} from ${inbound.sender}: ${outcome}`,
      );
    }
  }

  /**
   * Look up the registered homeserver of the user a message is attributed
   * to, for the pipeline's sender check. `userServerName` answers the
   * oracle's own server when the DID document names none or Blocksync is
   * unreachable, so a sender on the oracle's homeserver is accepted then and
   * a sender on any other server is not.
   */
  private async resolveSenderServer(inbound: InboundMessage): Promise<void> {
    const attribution = attributeUser({
      alias: this.roomAliases.get(inbound.roomId) ?? null,
      sender: inbound.sender,
      oracleDid: this.cfg().oracleRoomDid,
    });
    if (!attribution) return;
    const server = await this.userServerName(attribution.userDid);
    this.userServers.set(attribution.userDid, server.toLowerCase());
  }

  /** A membership change invalidates what the group-chat gate knows about the room. */
  protected override async onEvent(event: BotTimelineEvent): Promise<void> {
    await super.onEvent(event);
    if (event.type === 'm.room.member')
      this.groupChat().invalidateRoom(event.roomId);
  }

  /**
   * The group-room gate and channel memory, built once per instance on the
   * gateway's own SQLite. Summaries are produced by the speaker's user
   * object (the platform model's keys live there, not in this script).
   */
  private groupChat(): GroupChatService {
    if (this.groupChatService) return this.groupChatService;
    const cfg = this.cfg();
    this.groupChatService = new GroupChatService(
      this.ctx.storage.sql,
      {
        botUserId: cfg.userId,
        isOracleRoom: async (roomId) => {
          const alias = await this.canonicalAliasOf(roomId);
          return (
            alias !== null &&
            userDidFromRoomAlias(alias, cfg.oracleRoomDid) !== null
          );
        },
        getRoomStateEvent: (roomId, type, stateKey) =>
          this.getRoomStateEvent(roomId, type, stateKey),
        getJoinedRoomMembers: (roomId) => this.getJoinedRoomMembers(roomId),
        getEvent: (roomId, eventId) => this.getEvent(roomId, eventId),
        getUserProfile: (userId) => this.getUserProfile(userId),
        summarize: (messages) => {
          const last = messages[messages.length - 1];
          if (!last) return Promise.resolve(null);
          return this.userStub(last.senderDid).summarizeGroupMessages(
            JSON.stringify(messages),
          );
        },
        keepAlive: (work) => this.ctx.waitUntil(work),
        log: (level, msg, extra) => this.log(level, msg, extra),
      },
      groupChatOptionsFromEnv(this.env),
    );
    return this.groupChatService;
  }

  /**
   * The thread of an inbound message — its session (`reply-chain.ts`): the
   * SDK's `threadRootId` (an explicit `m.thread` relation), the root of the
   * chain a quote-reply answers, or the message itself when it is bare.
   */
  private async threadRootFor(
    eventId: string,
    roomId: string,
    relatesTo: MatrixRelatesTo | undefined,
    sdkThreadRootId?: string,
  ): Promise<string> {
    if (sdkThreadRootId) return sdkThreadRootId;
    return resolveReplyChainRoot({
      eventId,
      relatesTo,
      cache: this.threadRoots,
      fetchRelatesTo: async (id) => this.relatesToOf(roomId, id),
    });
  }

  /** `m.relates_to` of a room event from the homeserver; null when the event is unavailable. */
  private async relatesToOf(
    roomId: string,
    eventId: string,
  ): Promise<MatrixRelatesTo | null> {
    const json = await this.getEvent(roomId, eventId);
    if (!json) return null;
    return readRelatesTo(eventContentOf(json)) ?? {};
  }

  /**
   * The thread of an inbox row on replay. A row whose turn was resolved
   * before the reset carries it; one interrupted between the insert and the
   * resolution has to read its own event back (relations travel in the
   * clear, so an encrypted event answers too). Unreadable → the message is
   * treated as bare, which is right for every message without a relation.
   */
  private async threadRootForRow(row: InboxRow): Promise<string> {
    if (row.threadRootId) return row.threadRootId;
    let relatesTo: MatrixRelatesTo | undefined;
    try {
      relatesTo =
        (await this.relatesToOf(row.roomId, row.eventId)) ?? undefined;
    } catch (err) {
      this.log(
        'warn',
        `inbox: could not read ${row.eventId} back to resolve its thread; treating it as a bare message`,
        err,
      );
      relatesTo = undefined;
    }
    return this.threadRootFor(row.eventId, row.roomId, relatesTo);
  }

  /** `m.room.canonical_alias` of a room, memoised per instance (null = none). */
  private async canonicalAliasOf(roomId: string): Promise<string | null> {
    const memo = this.roomAliases.get(roomId);
    if (memo !== undefined) return memo;
    const json = await this.getRoomStateEvent(roomId, 'm.room.canonical_alias');
    const parsed: unknown = json ? JSON.parse(json) : null;
    const alias =
      typeof parsed === 'object' &&
      parsed !== null &&
      'alias' in parsed &&
      typeof parsed.alias === 'string' &&
      parsed.alias
        ? parsed.alias
        : null;
    this.roomAliases.set(roomId, alias);
    return alias;
  }

  private async dispatchTurn(turn: IngestTurn): Promise<void> {
    return this.turnGate.run(() => this.dispatchTurnNow(turn));
  }

  private async dispatchTurnNow(turn: IngestTurn): Promise<void> {
    const requestId = crypto.randomUUID();
    // Group rooms: the Node gate — answer a mention, a reply to the bot, or
    // a thread the bot is in; stay silent otherwise (the message is still
    // captured into channel memory). Direct rooms always pass.
    const decision = await this.groupChat()
      .gate({
        roomId: turn.roomId,
        threadId: turn.threadId,
        eventId: turn.sourceEventId,
        sender: turn.matrixUserId,
        senderDid: turn.userDid,
        body: turn.message,
        ts: turn.ts,
        mentionsBot: turn.mentionsBot,
        ...(turn.inReplyTo ? { inReplyTo: turn.inReplyTo } : {}),
      })
      .catch((err: unknown): GateDecision => {
        this.log(
          'warn',
          `turn ${requestId}: group-chat gate failed; answering`,
          err,
        );
        return {
          respond: true,
          reason: 'dm',
          roomKind: 'direct',
          memberCount: 0,
          displayName: turn.matrixUserId,
        };
      });
    if (!decision.respond) {
      this.log(
        'info',
        `turn ${requestId}: ${turn.userDid} in ${turn.roomId} (thread ${turn.threadId}) not answered (${decision.reason})`,
      );
      deleteInboxRows(this.inboxSql(), turn.eventIds);
      return;
    }
    this.log(
      'info',
      `turn ${requestId}: ${turn.userDid} in ${turn.roomId} (thread ${turn.threadId}${decision.roomKind === 'group' ? `, group room: ${decision.reason}` : ''})`,
    );
    for (const id of turn.eventIds) this.inFlightEvents.add(id);
    let typing: ReturnType<typeof setInterval> | null = null;
    try {
      await this.setTyping(turn.roomId, true, TYPING_TIMEOUT_MS);
      typing = setInterval(() => {
        this.setTyping(turn.roomId, true, TYPING_TIMEOUT_MS).catch(
          () => undefined,
        );
      }, TYPING_REFRESH_MS);
      const result = await this.runTurn(turn, requestId, decision);
      if (result.replayed)
        this.log(
          'info',
          `turn ${requestId}: reply served from the user object's ledger (turn had already finished)`,
        );
      if (result.text.trim()) {
        // The transaction id is derived from the event id, so this reply is
        // deduplicated by the homeserver if a previous incarnation already
        // sent it before it died (see inbox-store.ts).
        // Always inside the thread: the reply to a bare message opens the
        // thread on it (Node's listener bridge does the same).
        await this.sendText(turn.roomId, result.text, {
          threadId: turn.threadId,
          ...(turn.eventIds[0] ? { txnId: replyTxnId(turn.eventIds[0]) } : {}),
        });
      } else {
        this.log('info', `turn ${requestId}: empty reply, nothing sent`);
      }
      // The reply is in the durable outbox (or there is none): the turn
      // has ended, the inbox row has done its job.
      deleteInboxRows(this.inboxSql(), turn.eventIds);
    } catch (err) {
      // A turn aborted because a newer message on the same thread superseded
      // it is not a failure: the new turn answers, the old card says so.
      if (isAbortError(err)) {
        this.log('info', `turn ${requestId}: superseded by a newer message`);
        deleteInboxRows(this.inboxSql(), turn.eventIds);
        return;
      }
      if (isInterruptedTurnError(err))
        this.log(
          'warn',
          `turn ${requestId}: the user object lost this turn in a reset and will not re-run it; asking the user to retry`,
        );
      else this.log('error', `turn ${requestId} failed`, err);
      try {
        await this.sendNotice(turn.roomId, TURN_FAILED_NOTICE, {
          threadId: turn.threadId,
          ...(turn.eventIds[0]
            ? { txnId: `${replyTxnId(turn.eventIds[0])}-notice` }
            : {}),
        });
      } catch (noticeErr) {
        this.log(
          'error',
          `turn ${requestId}: could not post error notice`,
          noticeErr,
        );
      }
      // Told the user (or could not): either way this turn is over.
      deleteInboxRows(this.inboxSql(), turn.eventIds);
    } finally {
      for (const id of turn.eventIds) this.inFlightEvents.delete(id);
      if (typing) clearInterval(typing);
      await this.setTyping(turn.roomId, false).catch(() => undefined);
      // Close the card on every exit — reply posted, empty reply, thrown
      // error — so no turn can leave a spinner running in the room.
      await this.userStub(turn.userDid)
        .finishWorkStatus(requestId, 'done')
        .catch((err: unknown) =>
          this.log(
            'warn',
            `turn ${requestId}: could not close the status card`,
            err,
          ),
        );
    }
  }

  private userStub(userDid: string): DurableObjectStub<UserOracleObject> {
    return this.env.USER_ORACLE.get(
      this.env.USER_ORACLE.idFromName(
        userObjectName(userDid, this.cfg().oracleDid),
      ),
    );
  }

  /** Run the turn in the user's object. */
  protected async runTurn(
    turn: IngestTurn,
    requestId: string,
    decision: GateDecision,
  ): Promise<TurnResult> {
    return this.userStub(turn.userDid).runTurn({
      identity: { userDid: turn.userDid, matrixUserId: turn.matrixUserId },
      sessionId: turn.sessionId,
      message: turn.message,
      client: 'matrix',
      roomId: turn.roomId,
      threadId: turn.threadId,
      roomKind: decision.roomKind,
      senderDisplayName: decision.displayName,
      ...(turn.eventIds[0] ? { eventId: turn.eventIds[0] } : {}),
      ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
      requestId,
    });
  }

  // -------------------------------------------------------------------------
  // Turn inbox: room messages whose reply is not in the outbox yet
  // -------------------------------------------------------------------------

  private inboxSql(): SqlStorage {
    const sql = this.ctx.storage.sql;
    if (!this.inboxTableReady) {
      ensureInboxTable(sql);
      this.inboxTableReady = true;
    }
    return sql;
  }

  /**
   * After every successful start of this instance — a request, the
   * keep-alive alarm bringing it back after a reset, a device rotation
   * (the SDK's `onStarted` hook, detached from the caller). That is the
   * moment to re-dispatch the turns a previous incarnation left unfinished.
   */
  protected override async onStarted(_result: StartResult): Promise<void> {
    this.scheduleInboxReplay();
  }

  private scheduleInboxReplay(): void {
    if (this.inboxReplayRunning) return;
    this.inboxReplayRunning = true;
    void this.replayInbox()
      .catch((err: unknown) => this.log('error', 'inbox replay failed', err))
      .finally(() => {
        this.inboxReplayRunning = false;
      });
  }

  /**
   * Re-dispatch the messages whose turn never ended. Each replay is charged
   * to the row; a row that has used its replays gets the "try again" notice
   * instead, so a message that kills the instance cannot loop. The user
   * object decides what a replay means for it (`matrix-turn-ledger.ts`):
   * stored reply, attach to the running turn, or refuse — never a second run.
   */
  private async replayInbox(): Promise<void> {
    const sql = this.inboxSql();
    const rows = listInboxRows(sql);
    if (rows.length === 0) return;
    const plan = planInboxReplay(rows, {
      inFlight: this.inFlightEvents,
      maxReplays: MAX_TURN_REPLAYS,
    });
    for (const row of plan.exhausted) {
      this.log(
        'warn',
        `inbox: giving up on ${row.eventId} in ${row.roomId} after ${row.attempts} replays; notifying the user`,
      );
      try {
        await this.sendNotice(row.roomId, TURN_FAILED_NOTICE, {
          threadId: row.threadRootId ?? row.eventId,
          txnId: `${replyTxnId(row.eventId)}-notice`,
        });
      } catch (err) {
        this.log(
          'error',
          `inbox: could not post the notice for ${row.eventId}`,
          err,
        );
      }
      deleteInboxRows(sql, [row.eventId]);
    }
    if (plan.replay.length > 0)
      bumpInboxAttempts(
        sql,
        plan.replay.map((row) => row.eventId),
      );
    for (const row of plan.replay) {
      try {
        await this.canonicalAliasOf(row.roomId);
      } catch (err) {
        this.log('warn', `inbox: alias lookup failed for ${row.roomId}`, err);
      }
      const inbound = inboundOfRow(row);
      try {
        await this.resolveSenderServer(inbound);
      } catch (err) {
        // Offering now would drop the message as foreign; the row stays and
        // the next replay tries again (its attempts were bumped above).
        this.log(
          'warn',
          `inbox: homeserver lookup failed for ${inbound.sender}; keeping ${row.eventId} for the next replay`,
          err,
        );
        continue;
      }
      const threadRootId = await this.threadRootForRow(row);
      if (threadRootId !== inbound.threadRootId) {
        inbound.threadRootId = threadRootId;
        updateInboxThread(sql, row.eventId, threadRootId);
      }
      this.offerInbound(inbound);
    }
    this.log(
      'info',
      `inbox replay: ${plan.replay.length} turn(s) re-dispatched, ${plan.exhausted.length} given up, ${plan.skipped.length} already running`,
    );
  }

  /**
   * Operator / testing aid behind `ORACLE_DEBUG_ROUTES`: reset this object
   * the way an unplanned platform reset does — in-flight turns and the sync
   * loop die, committed storage (outbox, inbox, crypto snapshot) survives,
   * the next request or alarm boots a fresh instance. The RPC rejects.
   */
  async debugAbortObject(): Promise<void> {
    // Worded like the platform's own reset so RPC callers classify it as
    // transient (see `isTransientGatewayError`), exactly as in production.
    this.ctx.abort('gateway reset requested by the debug route');
  }

  override async stop(): Promise<void> {
    // A debounce buffer firing after the stop would send through
    // `startedClient()`, which restarts the bot.
    this.ingest?.clear();
    await super.stop();
  }

  // -------------------------------------------------------------------------
  // Rooms
  // -------------------------------------------------------------------------

  private async userServerName(userDid: string): Promise<string> {
    const cfg = this.cfg();
    const cacheKey = `hs:${userDid}`;
    const cached = await this.ctx.storage.get<HomeserverCacheEntry>(cacheKey);
    if (cached && Date.now() - cached.at < HOMESERVER_CACHE_TTL_MS) {
      return cached.serverName;
    }
    const blocksync = this.env.BLOCKSYNC_GRAPHQL_URL;
    if (!blocksync) return cfg.serverName;
    try {
      const resolved = await fetchUserMatrixServerName(blocksync, userDid);
      if (!resolved) return cfg.serverName;
      await this.ctx.storage.put(cacheKey, {
        serverName: resolved,
        at: Date.now(),
      } satisfies HomeserverCacheEntry);
      if (resolved !== cfg.serverName) {
        this.log(
          'info',
          `user ${userDid} lives on ${resolved} (oracle is on ${cfg.serverName}); room alias uses the user's server`,
        );
      }
      return resolved;
    } catch (err) {
      this.log(
        'warn',
        `could not resolve ${userDid}'s homeserver from Blocksync; using ${cfg.serverName}`,
        err,
      );
      return cfg.serverName;
    }
  }

  async resolveUserRoom(
    userDid: string,
  ): Promise<{ roomId: string; alias: string } | null> {
    const alias = userOracleRoomAlias(
      userDid,
      this.cfg().oracleRoomDid,
      await this.userServerName(userDid),
    );
    const cacheKey = `alias:${userDid}`;
    const cached = await this.ctx.storage.get<AliasCacheEntry>(cacheKey);
    if (
      cached &&
      cached.alias === alias &&
      Date.now() - cached.at < ALIAS_CACHE_TTL_MS
    ) {
      return { roomId: cached.roomId, alias };
    }
    const roomId = await this.resolveAlias(alias);
    if (!roomId) return null;
    await this.ctx.storage.put(cacheKey, {
      roomId,
      alias,
      at: Date.now(),
    } satisfies AliasCacheEntry);
    return { roomId, alias };
  }

  /**
   * Create a private room the bot owns (dedicated `[Task] <title>` rooms) and
   * invite the given users. Like the Node runtime's `createDedicatedRoom`:
   * `private_chat` preset, no alias. Replies in it route to the sender's
   * object (no alias → the sender's own DID), so nothing else is recorded.
   */
  async createDedicatedRoom(
    opts: CreateRoomOptions,
  ): Promise<{ roomId: string }> {
    const roomId = await this.createRoom(
      JSON.stringify({
        name: opts.name,
        ...(opts.topic ? { topic: opts.topic } : {}),
        visibility: Visibility.Private,
        preset: Preset.PrivateChat,
        invite: opts.invite,
      }),
    );
    this.log(
      'info',
      `created room ${roomId} (${opts.name}) for ${opts.userDid}`,
    );
    return { roomId };
  }

  override async getRoomState(roomId: string): Promise<JsonString> {
    const deadline = Date.now() + PENDING_INVITE_GRACE_MS;
    for (;;) {
      try {
        return await super.getRoomState(roomId);
      } catch (err) {
        // 403 = not a member. If the oracle was only just invited (a page
        // room created by the user seconds ago), accept the invite here
        // instead of waiting for the sync loop, then read again. The join
        // fails quietly for a room we are not invited to.
        if (!isForbidden(err) || Date.now() > deadline) throw err;
        await this.joinRoom(roomId).catch(() => undefined);
        await sleep(250);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Oracle secrets key (P-256 private JWK from the account room)
  // -------------------------------------------------------------------------

  /**
   * Load the oracle's P-256 secrets key from its Matrix *account* room —
   * the port of the chain-client's `loadEncryptionKey`
   * (`matrix-bot/setup-encryption-key.ts`): the state event
   * `ixo.room.encryption_key.index` / `p256_encryption` names the active
   * key's timeline event, whose `encrypted_private_key` is AES-256-CBC
   * encrypted with `MATRIX_VALUE_PIN` (`ivHex:cipherHex`, key =
   * `pin.padEnd(32)` UTF-8 — the exact scheme of the chain-client's
   * `decrypt` in `setup-claim-signing-mnemonics.ts`). Returns the private
   * JWK JSON, or null when the key is not provisioned / env is unset.
   * Memoised for the life of this object (the Node runtime loads it once at
   * boot).
   */
  async getOracleSecretsKey(): Promise<JsonString | null> {
    if (this.oracleSecretsKeyJson !== null) return this.oracleSecretsKeyJson;
    const roomId = this.env.MATRIX_ACCOUNT_ROOM_ID;
    const pin = this.env.MATRIX_VALUE_PIN;
    if (!roomId || !pin) {
      this.log(
        'debug',
        'secrets key unavailable: MATRIX_ACCOUNT_ROOM_ID / MATRIX_VALUE_PIN not set',
      );
      return null;
    }
    await this.ensureStarted();
    const indexJson = await this.getRoomStateEvent(
      roomId,
      'ixo.room.encryption_key.index',
      'p256_encryption',
    );
    if (!indexJson) {
      this.log(
        'warn',
        'no encryption key index in the account room — run "oracles-cli setup-encryption-key" to provision one',
      );
      return null;
    }
    const indexContent = JSON.parse(indexJson) as {
      keys?: Record<string, { eventId?: string; active?: boolean }>;
    };
    const entries = Object.entries(indexContent.keys ?? {});
    const active = entries.find(([, entry]) => entry.active === true);
    if (!active || typeof active[1].eventId !== 'string') {
      this.log('warn', 'encryption key index exists but has no active key');
      return null;
    }
    const eventJson = await this.getEvent(roomId, active[1].eventId);
    if (!eventJson) {
      this.log(
        'warn',
        `encryption key event ${active[1].eventId} not found in the account room`,
      );
      return null;
    }
    const event = JSON.parse(eventJson) as {
      content?: { encrypted_private_key?: unknown };
    };
    const encrypted = event.content?.encrypted_private_key;
    if (typeof encrypted !== 'string' || encrypted.length === 0) {
      this.log(
        'warn',
        `encryption key event ${active[1].eventId} has no encrypted_private_key`,
      );
      return null;
    }
    const jwkJson = await decryptWithPin(encrypted, pin);
    // Round-trip through JSON.parse to fail fast on a wrong PIN (garbage
    // plaintext) before any user object seats it.
    JSON.parse(jwkJson);
    this.oracleSecretsKeyJson = jwkJson;
    this.log('info', 'oracle secrets key loaded from the account room');
    return jwkJson;
  }

  /**
   * The oracle's UCAN signing mnemonic from the account room — the Node
   * runtime's storage (`setup-claim-signing-mnemonics.ts`): state event
   * `ixo.room.state.secure` / `encrypted_mnemonic_ed_signing`, content
   * `{ encrypted_mnemonic: 'ivHex:cipherHex' }`, AES-256-CBC with
   * `MATRIX_VALUE_PIN` (the same cipher as the secrets key above). Read-only:
   * provisioning (generate, store, publish the verification method on chain)
   * stays with the Node runtime and the CLI. Memoised for the life of this
   * object. Every failure is logged and yields null — a user object then
   * runs without a signing key, exactly as with no `ORACLE_SIGNING_MNEMONIC`.
   */
  async getOracleSigningMnemonic(): Promise<string | null> {
    if (this.oracleSigningMnemonic !== null) return this.oracleSigningMnemonic;
    const roomId = this.env.MATRIX_ACCOUNT_ROOM_ID;
    const pin = this.env.MATRIX_VALUE_PIN;
    if (!roomId || !pin) {
      this.log(
        'warn',
        'signing mnemonic unavailable: ORACLE_SIGNING_MNEMONIC is unset and MATRIX_ACCOUNT_ROOM_ID / MATRIX_VALUE_PIN are not set',
      );
      return null;
    }
    await this.ensureStarted();
    const stateJson = await this.getRoomStateEvent(
      roomId,
      SIGNING_MNEMONIC_STATE_TYPE,
      SIGNING_MNEMONIC_STATE_KEY,
    );
    if (!stateJson) {
      this.log(
        'warn',
        `no ${SIGNING_MNEMONIC_STATE_TYPE}/${SIGNING_MNEMONIC_STATE_KEY} in the account room — set ORACLE_SIGNING_MNEMONIC or provision the mnemonic with the Node runtime / CLI; downstream UCAN minting stays off`,
      );
      return null;
    }
    const encrypted = encryptedMnemonicOf(stateJson);
    if (!encrypted) {
      this.log(
        'warn',
        `${SIGNING_MNEMONIC_STATE_KEY} in the account room carries no encrypted_mnemonic — downstream UCAN minting stays off`,
      );
      return null;
    }
    let plain: string;
    try {
      plain = await decryptWithPin(encrypted, pin);
    } catch (err) {
      this.log(
        'error',
        `could not decrypt ${SIGNING_MNEMONIC_STATE_KEY} with MATRIX_VALUE_PIN (wrong PIN?): ${err instanceof Error ? err.message : String(err)} — downstream UCAN minting stays off`,
      );
      return null;
    }
    const mnemonic = parseSigningMnemonic(plain);
    if (!mnemonic) {
      this.log(
        'error',
        `${SIGNING_MNEMONIC_STATE_KEY} decrypted to something that is not a BIP-39 mnemonic (wrong PIN?) — downstream UCAN minting stays off`,
      );
      return null;
    }
    this.oracleSigningMnemonic = mnemonic;
    this.log(
      'info',
      `oracle signing mnemonic loaded from the account room (${mnemonic.split(' ').length} words)`,
    );
    return mnemonic;
  }

  // -------------------------------------------------------------------------
  // User snapshots (SQLite files as room media) and media downloads
  // -------------------------------------------------------------------------

  async uploadUserSnapshotStream(
    userDid: string,
    storageKey: string,
    body: ReadableStream<Uint8Array>,
    filename: string,
    size: number,
  ): Promise<{ eventId: string }> {
    const target = await this.resolveUserRoom(userDid);
    if (!target)
      throw new Error(`MatrixGatewayDO: no user↔oracle room for ${userDid}`);
    const roomId = target.roomId;
    // Look up the previous media event FIRST so it is redacted only after the
    // replacement is live (a failed upload must not destroy the old copy).
    const oldEventId = stateEventId(
      await this.getRoomStateEvent(roomId, MEDIA_STATE_TYPE, storageKey),
    );
    // `{"file":{…}}` (encrypted) or `{"url":"mxc://…"}`, per the room.
    // Streamed: encrypted chunk by chunk in an E2EE room and sent with the
    // exact length; the whole-buffer upload grew the crypto WASM heap for good.
    const source: unknown = JSON.parse(
      await this.uploadFileStream(roomId, body, {
        filename,
        mimetype: SNAPSHOT_MIMETYPE,
        size,
      }),
    );
    const content = {
      msgtype: 'm.file',
      body: storageKey,
      filename: storageKey,
      cid: storageKey,
      sender: this.cfg().userId,
      info: { mimetype: SNAPSHOT_MIMETYPE, size },
      ...(typeof source === 'object' && source !== null ? source : {}),
    };
    const eventId = await this.sendEvent(
      roomId,
      MEDIA_UPLOAD_TYPE,
      JSON.stringify(content),
    );
    await this.sendStateEvent(
      roomId,
      MEDIA_STATE_TYPE,
      JSON.stringify({ eventId }),
      storageKey,
    );
    if (oldEventId && oldEventId !== eventId) {
      try {
        await this.sendEvent(
          roomId,
          'm.room.redaction',
          JSON.stringify({
            redacts: oldEventId,
            reason: 'Replacing with updated file',
          }),
        );
      } catch (err) {
        this.log(
          'warn',
          `could not redact previous snapshot ${oldEventId}`,
          err,
        );
      }
    }
    this.log(
      'info',
      `uploaded snapshot ${storageKey} (${size} bytes) for ${userDid} → ${eventId}`,
    );
    return { eventId };
  }

  async downloadUserSnapshotStream(
    userDid: string,
    storageKey: string,
  ): Promise<SnapshotStream | null> {
    const target = await this.resolveUserRoom(userDid);
    if (!target) return null;
    const eventId = stateEventId(
      await this.getRoomStateEvent(target.roomId, MEDIA_STATE_TYPE, storageKey),
    );
    if (!eventId) return null;
    const media = await this.mediaStream(target.roomId, eventId);
    return media ? { ...media, eventId } : null;
  }

  /**
   * A media event as a stream, AS STORED — raw ciphertext plus the
   * `EncryptedFile` fields in an E2EE room. Decryption happens in the calling
   * object: the SDK's whole-buffer `downloadFile` decrypts in the crypto WASM
   * and grows its heap for good, and a stream that fails its hash check on
   * this side of the RPC would reach the caller as a bare disconnect.
   */
  private async mediaStream(
    roomId: string,
    eventId: string,
  ): Promise<MediaStream | null> {
    const media = await this.downloadFileStream(roomId, eventId, {
      raw: true,
    });
    if (!media) return null;
    return {
      stream: media.stream,
      ...(media.file ? { file: media.file } : {}),
      ...(media.size !== undefined ? { size: media.size } : {}),
      ...(media.mimetype ? { mimetype: media.mimetype } : {}),
      ...(media.filename ? { filename: media.filename } : {}),
    };
  }

  /**
   * A media message (`m.image` / `m.file` / …) for the attachments pipeline,
   * as stored (see `mediaStream`). Null when the event is unknown or redacted.
   */
  async downloadEventMediaStream(
    roomId: string,
    eventId: string,
  ): Promise<MediaStream | null> {
    return this.mediaStream(roomId, eventId);
  }

  /** Authenticated download of an `mxc://` URI as a stream (`/_matrix/client/v1/media/download`, legacy fallback on 404). */
  async downloadMxcMediaStream(
    mxc: string,
  ): Promise<ReadableStream<Uint8Array>> {
    const client = await this.startedClient();
    const token = client.getAccessToken();
    const headers: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};
    const authed = client.mxcUrlToHttp(
      mxc,
      undefined,
      undefined,
      undefined,
      false,
      true,
      true,
    );
    if (!authed) throw new Error(`MatrixGatewayDO: invalid mxc url ${mxc}`);
    let res = await fetch(authed, { headers });
    if (res.status === 404) {
      const legacy = client.mxcUrlToHttp(
        mxc,
        undefined,
        undefined,
        undefined,
        false,
        true,
        false,
      );
      if (legacy) res = await fetch(legacy, { headers });
    }
    if (!res.ok)
      throw new Error(
        `MatrixGatewayDO: media download failed: ${res.status} ${res.statusText}`,
      );
    if (!res.body)
      throw new Error('MatrixGatewayDO: media download has no body');
    return res.body;
  }

  // -------------------------------------------------------------------------
  // Plugins' device
  // -------------------------------------------------------------------------

  /**
   * Password login with Synapse's per-address login rate limit handled: every
   * object shares the Worker's egress addresses, so parallel boots can see
   * 429 with `retry_after_ms`, which the SDK's own login call does not retry.
   */
  private async passwordLogin(opts: {
    displayName: string;
    deviceId?: string;
  }): Promise<StoredDevice> {
    const cfg = this.cfg();
    const login = createClient({ baseUrl: cfg.baseUrl });
    const localpart = cfg.userId.slice(1, cfg.userId.indexOf(':'));
    const res = await withRateLimitRetry(
      () =>
        login.login('m.login.password', {
          identifier: { type: 'm.id.user', user: localpart },
          password: cfg.password,
          initial_device_display_name: opts.displayName,
          ...(opts.deviceId ? { device_id: opts.deviceId } : {}),
        }),
      {
        retries: LOGIN_RETRY_ATTEMPTS,
        maxWaitMs: LOGIN_RETRY_MAX_MS,
        onWait: (waitMs, attempt) =>
          this.log(
            'warn',
            `login rate-limited (attempt ${attempt}); retrying in ${waitMs} ms`,
          ),
      },
    );
    if (!res.access_token || !res.device_id)
      throw new Error(
        'MatrixGatewayDO: login returned no access_token/device_id',
      );
    if (res.user_id !== cfg.userId)
      throw new Error(
        `MatrixGatewayDO: logged in as ${res.user_id}, expected ${cfg.userId}`,
      );
    return {
      userId: res.user_id,
      deviceId: res.device_id,
      accessToken: res.access_token,
    };
  }

  /**
   * See `MatrixGatewayObject.botCredentials`: a second password device with
   * NO crypto store, for plugins that drive a raw matrix-js-sdk client
   * (editor, flows) — it must never be the gateway's own E2EE device, whose
   * one-time keys and store are the SDK's. Its id is pinned in storage so a
   * re-login (token rejected) keeps the same device. Cached per instance
   * after one `whoami`.
   */
  async botCredentials(): Promise<BotCredentials> {
    if (this.pluginDevice) return this.pluginDevice;
    const cfg = this.cfg();
    const stored = await this.ctx.storage.get<StoredDevice>(
      BOT_CLIENT_IDENTITY_KEY,
    );
    if (stored?.accessToken && stored.userId === cfg.userId) {
      try {
        const who = await createClient({
          baseUrl: cfg.baseUrl,
          accessToken: stored.accessToken,
          useAuthorizationHeader: true,
        }).whoami();
        if (who.device_id === stored.deviceId) {
          this.pluginDevice = { baseUrl: cfg.baseUrl, ...stored };
          return this.pluginDevice;
        }
      } catch (err) {
        this.log(
          'warn',
          'plugin device token rejected; re-logging in with the same device id',
          err,
        );
      }
    }
    const device = await this.passwordLogin({
      displayName: `QiForge oracle plugins (${this.env.ORACLE_NAME ?? 'workers'})`,
      ...(stored?.deviceId ? { deviceId: stored.deviceId } : {}),
    });
    await this.ctx.storage.put(BOT_CLIENT_IDENTITY_KEY, device);
    this.log('info', `plugin device ${device.deviceId} logged in`);
    this.pluginDevice = { baseUrl: cfg.baseUrl, ...device };
    return this.pluginDevice;
  }

  // -------------------------------------------------------------------------
  // Operator surface
  // -------------------------------------------------------------------------

  /** The durable outbox (pending sends), without message bodies. */
  async listOutbox(): Promise<OutboxRow[]> {
    return listPendingSends(this.ctx.storage.sql).map((row) => ({
      txnId: row.txnId,
      roomId: row.roomId,
      kind: row.kind,
      ...(row.threadId ? { threadId: row.threadId } : {}),
      bodyChars: row.body.length,
      htmlChars: row.formattedBody?.length ?? 0,
      attempts: row.attempts ?? 0,
      enqueuedAt: row.enqueuedAt,
    }));
  }

  // -------------------------------------------------------------------------
  // Group rooms: room kind + channel memory for the user objects' tools
  // -------------------------------------------------------------------------

  async groupChatRoomInfo(roomId: string): Promise<GroupRoomInfo> {
    const service = this.groupChat();
    return {
      ...(await service.roomInfo(roomId)),
      groupLane: service.options.groupRooms === 'gate',
    };
  }

  async channelMemoryRecall(
    roomId: string,
    limit?: number,
  ): Promise<JsonString> {
    return JSON.stringify(this.groupChat().recall(roomId, limit));
  }

  async channelMemorySearch(
    roomId: string,
    query: string,
    limit?: number,
  ): Promise<JsonString> {
    return JSON.stringify(this.groupChat().search(roomId, query, limit));
  }

  async channelMemoryPin(
    roomId: string,
    fact: string,
    pinnedByDid: string,
    sourceEventId?: string,
  ): Promise<JsonString> {
    return JSON.stringify(
      this.groupChat().pinFact({
        roomId,
        fact,
        pinnedByDid,
        ...(sourceEventId ? { sourceEventId } : {}),
      }),
    );
  }

  async channelMemoryUnpin(roomId: string, factId: string): Promise<boolean> {
    return this.groupChat().unpinFact(roomId, factId);
  }

  override async status(): Promise<GatewayStatus> {
    return {
      ...(await super.status()),
      turns: { inFlight: this.turnGate.inUse, waiting: this.turnGate.queued },
      groupChat: this.groupChat().stats(),
      ingestPending: this.ingest?.pendingCount ?? 0,
      inbox: countInboxRows(this.inboxSql()),
    };
  }
}

/** Attachment descriptor of a media message for the ingest (Node bridge shape). */
function attachmentOf(
  content: Record<string, unknown>,
  eventId: string,
  body: string,
): InboundAttachment {
  const info = readMediaInfo(content);
  const filename: unknown = content['filename'];
  return {
    eventId,
    filename: typeof filename === 'string' ? filename : body || 'file',
    mimetype: info.mimetype ?? 'application/octet-stream',
    ...(info.size !== undefined ? { size: info.size } : {}),
  };
}

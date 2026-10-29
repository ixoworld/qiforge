/**
 * Session-history → memory-engine indexing — the Workers port of the Node
 * runtime's `SessionHistoryProcessor` (`modules/sessions/session-history-
 * processor.service.ts`).
 *
 * Policy (Node's, plus the channel trigger and the bounds below):
 *  - Runs in the background when a session is CREATED (indexes the most
 *    recent previous session) and when a session is DELETED (indexes it
 *    before it goes), on the last realtime disconnection, and once a channel
 *    session has been quiet for a while after its last finished run
 *    (`processAfterQuiet`: a new finish restarts the wait, so a burst of
 *    turns costs one upload). The request never waits for, or fails on,
 *    indexing.
 *  - Only messages after the session's `lastProcessedCount` are sent, then
 *    the count is advanced — a session is never indexed twice. The tail is
 *    read page by page from a resume cursor this indexer keeps per session
 *    (valid while the stored count still matches it), so a long session is
 *    not re-read on every pass; without one (a fresh object, a rewritten
 *    transcript) the transcript is scanned from the start once. The tail is
 *    uploaded in chunks (`chunkMaxMessages` / `chunkMaxBytes`) and the count
 *    advances after each accepted chunk, so a failure never grows the next
 *    request body.
 *  - After a pass fails, the session is not tried again for a backoff that
 *    doubles from `backoffInitialMs` up to `backoffMaxMs` and resets on
 *    success: an engine outage costs one retry envelope per window, not one
 *    per finished turn. Deleting a session ignores the backoff (it is the
 *    transcript's last chance).
 *  - Speakers get real identities (the user's preferred name / the oracle's
 *    preferred or configured name) so Graphiti's extractor does not pin
 *    facts to literal "user"/"assistant" nodes. Tool replies fold into the
 *    assistant role (the engine has no tool role).
 *  - Auth is the oracle's two-hop UCAN invocation minted from the user's
 *    delegation (`ixo:memory` / `memory/*`) — no delegation, no indexing.
 *  - Endpoint: `POST <MEMORY_ENGINE_URL>/messages` with `x-room-id`, as
 *    `@ixo/common`'s `MemoryEngineService.processConversationHistory`, plus
 *    `x-oracle-entity-did`: the engine keys the user's space by the oracle's
 *    domain entity (`ORACLE_ENTITY_DID`). Without one nothing is indexed
 *    (one warning per indexer) and the watermark stays put.
 *  - A per-session lock prevents overlapping runs; a call that arrives while
 *    the session is being indexed (at any stage) schedules one more pass for
 *    when the current one ends, so the final tail of a chat is never left
 *    behind. A failed upload is retried within the pass (see
 *    `DEFAULT_MAX_RETRIES`).
 *
 * Not ported: Node also asks Matrix for the user's display name when no
 * preferred name is set; here the fallback is the literal "Me" straight away.
 */
import type { Logger } from '../plugin-api/types';
import { MEMORY_ENTITY_HEADER } from '../plugins/memory/memory-entity';

export interface HistoryMessage {
  /** LangChain message type: `human` | `ai` | `tool` | `system`. */
  type: string;
  content: string;
}

export interface MemoryEngineMessage {
  content: string;
  role_type: 'user' | 'assistant' | 'system';
  role?: string;
  name?: string;
  source_description?: string;
}

export interface IndexableSession {
  title?: string;
  roomId?: string;
  lastProcessedCount?: number;
}

/** One indexable message and the point a read resumes from after it. */
export interface HistoryEntry {
  message: HistoryMessage;
  /** Opaque to the indexer; handed back as `after` to read what follows. */
  cursor: string;
}

/** A page of a session transcript, oldest first. */
export interface HistoryPage {
  entries: HistoryEntry[];
  /** More messages may follow the last entry. */
  more: boolean;
}

/** Cursor of an in-memory transcript (`pageOfMessages`): the index of the next message. */
const ARRAY_CURSOR_PREFIX = '#';

/**
 * `readMessages` over a transcript already held in memory (a deleted
 * session's snapshot, tests). Its cursors are `#<index>`; any other cursor
 * is not one of its own and reads as lost (`null`).
 */
export function pageOfMessages(
  messages: readonly HistoryMessage[],
  after: string | null,
  limit: number,
): HistoryPage | null {
  let start = 0;
  if (after !== null) {
    if (!after.startsWith(ARRAY_CURSOR_PREFIX)) return null;
    start = Number(after.slice(ARRAY_CURSOR_PREFIX.length));
    if (!Number.isInteger(start) || start < 0 || start > messages.length)
      return null;
  }
  const end = Math.min(messages.length, start + Math.max(1, limit));
  const entries: HistoryEntry[] = [];
  for (let i = start; i < end; i += 1)
    entries.push({
      message: messages[i]!,
      cursor: `${ARRAY_CURSOR_PREFIX}${i + 1}`,
    });
  return { entries, more: end < messages.length };
}

export interface SpeakerLabels {
  user: string;
  oracle: string;
}

export interface SessionHistoryIndexerDeps {
  /** `MEMORY_ENGINE_URL`; undefined disables indexing (memory plugin absent). */
  memoryEngineUrl: string | undefined;
  /**
   * The configured `ORACLE_ENTITY_DID` (a well-formed domain entity DID),
   * sent as `x-oracle-entity-did`. Never the `ORACLE_DID` fallback:
   * undefined → every session is `skipped`.
   */
  entityDid: string | undefined;
  getSession(sessionId: string): Promise<IndexableSession | undefined>;
  /**
   * Up to about `limit` transcript messages after `after` (from the start
   * when null), summarisation bookkeeping already removed: the count
   * watermark counts these messages. Null when `after` no longer names a
   * point in the transcript; the indexer then scans from the start.
   */
  readMessages(
    sessionId: string,
    after: string | null,
    limit: number,
  ): Promise<HistoryPage | null>;
  setProcessedCount(sessionId: string, count: number): Promise<void>;
  /** The user↔oracle room, for sessions whose row carries none. */
  resolveUserRoom(): Promise<{ roomId: string } | null>;
  ucan: {
    hasSigningKey(): boolean;
    resolveServiceDid(serviceUrl: string): Promise<string | null>;
    mintInvocation(
      target: { did: string; capability: string },
      opts?: { can?: string },
    ): Promise<string>;
  };
  speakerLabels(roomId: string): Promise<SpeakerLabels>;
  /** Called after the engine accepted an upload for the room. */
  onIndexed?(roomId: string): void;
  logger: Logger;
  fetchImpl?: typeof fetch;
  /** Test hooks. */
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  retryDelayMs?: number;
  /** Hard timeout for the memory-engine request (default 20 s). */
  requestTimeoutMs?: number;
  /** Clock for the failure backoff (default `Date.now`). */
  now?: () => number;
  /** Messages per upload (default 200). */
  chunkMaxMessages?: number;
  /** Message content bytes (UTF-8) per upload (default 256 KiB; one larger message goes alone). */
  chunkMaxBytes?: number;
  /** First backoff after a failed pass (default 1 min); doubles per failure. */
  backoffInitialMs?: number;
  /** Longest backoff (default 1 h). */
  backoffMaxMs?: number;
}

export type IndexOutcome = 'processed' | 'skipped' | 'failed';

export interface ProcessOptions {
  /** Run even while the session is backing off after a failure (deletion). */
  ignoreBackoff?: boolean;
}

/** Quiet period after a channel session's last finished run before it is indexed. */
export const CHANNEL_HISTORY_INDEX_DEBOUNCE_MS_DEFAULT = 180_000;

/** `CHANNEL_HISTORY_INDEX_DEBOUNCE_MS` from the validated env (its schema default otherwise). */
export function channelHistoryIndexDebounceMs(
  env: Record<string, unknown>,
): number {
  const value = env['CHANNEL_HISTORY_INDEX_DEBOUNCE_MS'];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : CHANNEL_HISTORY_INDEX_DEBOUNCE_MS_DEFAULT;
}

/**
 * Bounded background work: the indexer runs under `ctx.waitUntil`, so the
 * whole retry envelope keeps the user object resident (and un-hibernatable
 * with sockets attached). Two attempts, a short pause, and a hard timeout on
 * the memory-engine request keep that under a minute; a failed session is
 * retried by its next trigger once its backoff has passed (the watermark
 * moved only for the chunks the engine accepted).
 */
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 3_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_CHUNK_MAX_MESSAGES = 200;
const DEFAULT_CHUNK_MAX_BYTES = 256 * 1024;
const DEFAULT_BACKOFF_INITIAL_MS = 60_000;
const DEFAULT_BACKOFF_MAX_MS = 3_600_000;
/** Sessions whose resume cursor / backoff is remembered, least recent dropped first. */
const MAX_TRACKED_SESSIONS = 256;

const utf8 = new TextEncoder();

/** Insert as most recent; drop the least recent entries beyond `max`. */
function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_TRACKED_SESSIONS) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

interface QuietWait {
  timer: ReturnType<typeof setTimeout>;
  /** Settles once the pass the wait ends in has finished. */
  done: Promise<void>;
  resolve: () => void;
}

/** Node's `transformMessagesToMemoryEngineFormat`, verbatim in mapping. */
export function transformMessagesToMemoryEngineFormat(
  messages: readonly HistoryMessage[],
  sessionTitle: string,
  userSpeakerLabel: string,
  oracleSpeakerLabel: string,
): MemoryEngineMessage[] {
  return messages.map((message) => {
    let role_type: MemoryEngineMessage['role_type'];
    let label: string;
    switch (message.type) {
      case 'human':
        role_type = 'user';
        label = userSpeakerLabel;
        break;
      case 'ai':
        role_type = 'assistant';
        label = oracleSpeakerLabel;
        break;
      case 'system':
        role_type = 'system';
        label = 'System';
        break;
      case 'tool':
        // The engine has no tool role — tool replies are the oracle
        // reporting back, so they share the oracle speaker label.
        role_type = 'assistant';
        label = oracleSpeakerLabel;
        break;
      default:
        role_type = 'user';
        label = userSpeakerLabel;
    }
    return {
      content: message.content,
      role_type,
      role: label,
      name: label,
      source_description: `Chat Session: ${sessionTitle}`,
    };
  });
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class SessionHistoryIndexer {
  /** Session → the pass running for it (reruns included). */
  private readonly inFlight = new Map<string, Promise<IndexOutcome>>();

  /** Sessions asked for again while a pass ran: one more pass follows it. */
  private readonly rerun = new Map<string, ProcessOptions>();

  /** Session → where its indexed tail ends, valid while the stored count is `count`. */
  private readonly cursors = new Map<
    string,
    { count: number; cursor: string }
  >();

  /** Session → no new pass before `until`; `delayMs` doubles per failure. */
  private readonly backoff = new Map<
    string,
    { until: number; delayMs: number }
  >();

  /** Session → its pending quiet-period wait (`processAfterQuiet`). */
  private readonly quiet = new Map<string, QuietWait>();

  private readonly fetchImpl: typeof fetch;

  private readonly now: () => number;

  private readonly chunkMaxMessages: number;

  private readonly chunkMaxBytes: number;

  private readonly backoffInitialMs: number;

  private readonly backoffMaxMs: number;

  private readonly sleep: (ms: number) => Promise<void>;

  private readonly maxRetries: number;

  private readonly retryDelayMs: number;

  private readonly requestTimeoutMs: number;

  /** The missing-entity warning has been logged (it is logged once). */
  private warnedNoEntity = false;

  constructor(private readonly deps: SessionHistoryIndexerDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch.bind(globalThis);
    this.sleep =
      deps.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.now = deps.now ?? Date.now;
    this.chunkMaxMessages = Math.max(
      1,
      deps.chunkMaxMessages ?? DEFAULT_CHUNK_MAX_MESSAGES,
    );
    this.chunkMaxBytes = Math.max(
      1,
      deps.chunkMaxBytes ?? DEFAULT_CHUNK_MAX_BYTES,
    );
    this.backoffInitialMs = deps.backoffInitialMs ?? DEFAULT_BACKOFF_INITIAL_MS;
    this.backoffMaxMs = Math.max(
      this.backoffInitialMs,
      deps.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS,
    );
  }

  /** Sessions currently being indexed (background work keeping the object busy). */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /** Whether indexing is configured at all (memory engine URL present). */
  get enabled(): boolean {
    return typeof this.deps.memoryEngineUrl === 'string';
  }

  /**
   * Index a session's unprocessed messages. Never throws: outcomes are
   * `processed`, `skipped` (nothing to do / prerequisites missing / backing
   * off / joined a running pass) or `failed` (upload failed after retries).
   * A call while the session is being indexed — at any stage, from the
   * session read to the last upload — schedules one more pass after the
   * running one and settles when that pass has, so a caller's `waitUntil`
   * covers the tail it asked for. A pending quiet-period wait for the
   * session is taken over by the pass that starts here.
   */
  process(sessionId: string, opts: ProcessOptions = {}): Promise<IndexOutcome> {
    const { logger } = this.deps;
    if (!this.enabled) {
      logger.log(
        `[history-indexer] MEMORY_ENGINE_URL not configured; not indexing session ${sessionId}`,
      );
      return Promise.resolve('skipped');
    }
    const entityDid = this.deps.entityDid;
    if (!entityDid) {
      if (!this.warnedNoEntity) {
        this.warnedNoEntity = true;
        logger.warn(
          `[history-indexer] ORACLE_ENTITY_DID is not a domain entity DID (did:ixo:entity:<32 hex>); the memory engine keys every space by it, so session history is not indexed`,
        );
      }
      return Promise.resolve('skipped');
    }
    const running = this.inFlight.get(sessionId);
    if (running) {
      const queued = this.rerun.get(sessionId);
      this.rerun.set(sessionId, {
        ignoreBackoff: Boolean(queued?.ignoreBackoff || opts.ignoreBackoff),
      });
      logger.log(
        `[history-indexer] session ${sessionId} is already being indexed, scheduling another pass`,
      );
      return running.then((): IndexOutcome => 'skipped');
    }
    const blocked = this.backoff.get(sessionId);
    if (!opts.ignoreBackoff && blocked && this.now() < blocked.until) {
      logger.log(
        `[history-indexer] session ${sessionId} failed recently; not retrying for another ${Math.ceil((blocked.until - this.now()) / 1000)}s`,
      );
      return Promise.resolve('skipped');
    }
    const waiting = this.quiet.get(sessionId);
    if (waiting) {
      clearTimeout(waiting.timer);
      this.quiet.delete(sessionId);
    }
    const pass = (async (): Promise<IndexOutcome> => {
      try {
        return await this.attempts(sessionId, entityDid);
      } finally {
        this.inFlight.delete(sessionId);
        const again = this.rerun.get(sessionId);
        if (again) {
          this.rerun.delete(sessionId);
          await this.process(sessionId, again);
        }
        waiting?.resolve();
      }
    })();
    this.inFlight.set(sessionId, pass);
    return pass;
  }

  /**
   * Index the session once it has been quiet for `delayMs`: each call
   * restarts the wait, so a burst of finished turns ends in one pass. The
   * promise settles when that pass has (hand it to `waitUntil`; a pending
   * timer is also what keeps a Durable Object resident until it fires). A
   * `delayMs` of 0 or less indexes at once.
   */
  processAfterQuiet(sessionId: string, delayMs: number): Promise<void> {
    if (delayMs <= 0 || !this.enabled || !this.deps.entityDid)
      return this.process(sessionId).then(() => undefined);
    const pending = this.quiet.get(sessionId);
    if (pending) clearTimeout(pending.timer);
    let resolve: () => void = () => {};
    const done =
      pending?.done ??
      new Promise<void>((settle) => {
        resolve = settle;
      });
    const wait: QuietWait = {
      done,
      resolve: pending?.resolve ?? resolve,
      timer: setTimeout(() => {
        if (this.quiet.get(sessionId) !== wait) return;
        this.quiet.delete(sessionId);
        // `process` never rejects.
        void this.process(sessionId).then(() => wait.resolve());
      }, delayMs),
    };
    this.quiet.set(sessionId, wait);
    return done;
  }

  /** The pass's attempts, with the failure backoff booked at its end. */
  private async attempts(
    sessionId: string,
    entityDid: string,
  ): Promise<IndexOutcome> {
    const { logger } = this.deps;
    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      try {
        const outcome = await this.processOnce(sessionId, entityDid);
        if (outcome === 'processed') {
          this.backoff.delete(sessionId);
          logger.log(
            `[history-indexer] indexed session ${sessionId} into the memory engine`,
          );
        }
        return outcome;
      } catch (err) {
        logger.warn(
          `[history-indexer] attempt ${attempt}/${this.maxRetries} failed for session ${sessionId}: ${describe(err)}`,
        );
        if (attempt < this.maxRetries) await this.sleep(this.retryDelayMs);
      }
    }
    const previous = this.backoff.get(sessionId);
    const delayMs = previous
      ? Math.min(previous.delayMs * 2, this.backoffMaxMs)
      : this.backoffInitialMs;
    remember(this.backoff, sessionId, {
      until: this.now() + delayMs,
      delayMs,
    });
    logger.error(
      `[history-indexer] giving up on session ${sessionId} after ${this.maxRetries} attempts; next try in ${Math.round(delayMs / 1000)}s at the earliest`,
    );
    return 'failed';
  }

  private async processOnce(
    sessionId: string,
    entityDid: string,
  ): Promise<IndexOutcome> {
    const { deps } = this;
    const { logger } = deps;
    const memoryEngineUrl = deps.memoryEngineUrl!.replace(/\/+$/, '');

    const session = await deps.getSession(sessionId);
    if (!session) {
      logger.warn(`[history-indexer] session ${sessionId} not found, skipping`);
      return 'skipped';
    }

    const roomId =
      session.roomId ?? (await deps.resolveUserRoom())?.roomId ?? null;
    if (!roomId) {
      logger.warn(
        `[history-indexer] no oracle room for session ${sessionId}, skipping`,
      );
      return 'skipped';
    }

    const lastProcessedCount = session.lastProcessedCount ?? 0;
    const tail = this.tailReader(sessionId, lastProcessedCount);
    let chunk = await tail.next();
    if (chunk.length === 0) {
      logger.log(
        `[history-indexer] no new messages for session ${sessionId} (lastProcessedCount: ${lastProcessedCount})`,
      );
      return 'skipped';
    }

    if (!deps.ucan.hasSigningKey()) {
      logger.warn(
        `[history-indexer] no UCAN signing key; skipping memory engine processing for session ${sessionId}`,
      );
      return 'skipped';
    }
    const memoryDid = await deps.ucan
      .resolveServiceDid(memoryEngineUrl)
      .catch((err: unknown) => {
        logger.warn(
          `[history-indexer] could not resolve the memory engine DID: ${describe(err)}`,
        );
        return null;
      });
    // One invocation per upload request.
    const mint = async (): Promise<string | null> => {
      if (!memoryDid) return null;
      try {
        return await deps.ucan.mintInvocation(
          { did: memoryDid, capability: 'ixo:memory' },
          // Claim the ability the user's delegation actually grants. A `'*'`
          // claim is satisfiable only by a `'*'` grant.
          { can: 'memory/*' },
        );
      } catch (err) {
        logger.warn(
          `[history-indexer] could not mint a memory engine invocation: ${describe(err)}`,
        );
        return null;
      }
    };

    const labels = await deps.speakerLabels(roomId);
    let count = lastProcessedCount;
    let uploaded = false;
    try {
      while (chunk.length > 0) {
        const transformed = transformMessagesToMemoryEngineFormat(
          // Tool-call-only AI turns carry no text; the engine has nothing to
          // extract from them and rejects empty episodes.
          chunk
            .map((entry) => entry.message)
            .filter((m) => m.content.trim().length > 0),
          session.title ?? '',
          labels.user,
          labels.oracle,
        );
        if (transformed.length > 0) {
          const invocation = await mint();
          if (!invocation) {
            // Node: a failed mint is a warn + skip, not a retry — the user
            // simply has not delegated `ixo:memory` to this oracle (yet).
            if (!uploaded) {
              logger.warn(
                `[history-indexer] no memory engine invocation for session ${sessionId}; skipping`,
              );
              return 'skipped';
            }
            throw new Error('no memory engine invocation for the next chunk');
          }
          const res = await this.fetchImpl(`${memoryEngineUrl}/messages`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${invocation}`,
              'X-Auth-Type': 'ucan',
              [MEMORY_ENTITY_HEADER]: entityDid,
              'x-room-id': roomId,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ messages: transformed }),
            signal: AbortSignal.timeout(this.requestTimeoutMs),
          });
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(
              `memory engine rejected the conversation (${res.status}): ${text.slice(0, 200)}`,
            );
          }
          uploaded = true;
        }
        count += chunk.length;
        await deps.setProcessedCount(sessionId, count);
        remember(this.cursors, sessionId, {
          count,
          cursor: chunk[chunk.length - 1]!.cursor,
        });
        logger.log(
          `[history-indexer] processed ${chunk.length} new messages for session ${sessionId} (lastProcessedCount → ${count})`,
        );
        chunk = await tail.next();
      }
    } finally {
      // Once per pass, also when a later chunk failed: what the engine
      // accepted already changes what the prefetch would recall.
      if (uploaded) deps.onIndexed?.(roomId);
    }
    return 'processed';
  }

  /**
   * Reads the unindexed tail in upload-sized chunks. It resumes from the
   * remembered cursor when that cursor belongs to the stored watermark;
   * otherwise (a fresh object, a count moved elsewhere, a cursor the store
   * no longer knows) it scans from the start and skips the `watermark`
   * messages already indexed.
   */
  private tailReader(
    sessionId: string,
    watermark: number,
  ): { next(): Promise<HistoryEntry[]> } {
    const known = this.cursors.get(sessionId);
    let cursor: string | null =
      known && known.count === watermark ? known.cursor : null;
    let skip = cursor === null ? watermark : 0;
    /** Messages handed out (and indexed, if the caller got that far) so far. */
    let consumed = watermark;
    let exhausted = false;
    const pageSize = this.chunkMaxMessages;
    return {
      next: async (): Promise<HistoryEntry[]> => {
        const chunk: HistoryEntry[] = [];
        let bytes = 0;
        while (!exhausted) {
          const page = await this.deps.readMessages(
            sessionId,
            cursor,
            pageSize,
          );
          if (page === null) {
            if (cursor === null) {
              exhausted = true;
              break;
            }
            // The transcript was rewritten under the cursor: start over,
            // skip what is indexed so far and collect this chunk again.
            this.cursors.delete(sessionId);
            cursor = null;
            skip = consumed;
            chunk.length = 0;
            bytes = 0;
            continue;
          }
          for (const entry of page.entries) {
            if (skip > 0) {
              skip -= 1;
              cursor = entry.cursor;
              continue;
            }
            const size = utf8.encode(entry.message.content).byteLength;
            if (
              chunk.length > 0 &&
              (chunk.length >= this.chunkMaxMessages ||
                bytes + size > this.chunkMaxBytes)
            ) {
              consumed += chunk.length;
              return chunk;
            }
            chunk.push(entry);
            bytes += size;
            cursor = entry.cursor;
          }
          if (!page.more || page.entries.length === 0) exhausted = true;
        }
        consumed += chunk.length;
        return chunk;
      },
    };
  }
}

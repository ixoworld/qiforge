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
 *    transcript) the transcript is scanned from the start once.
 *  - The tail goes up as consecutive requests ("parts"), oldest first, each
 *    within the engine's request rules: at most `MEMORY_UPLOAD_MAX_MESSAGES`
 *    messages AFTER the conversation filter, at most
 *    `MEMORY_UPLOAD_MAX_REQUEST_BYTES` of JSON body, and no message content
 *    over `MEMORY_UPLOAD_MAX_MESSAGE_BYTES` (a longer message is split into
 *    marked pieces, and cut with a marker past `MAX_PIECES_PER_MESSAGE`). A
 *    part always holds whole transcript messages, and the count advances
 *    after each accepted part: a failure in part N keeps parts 1..N-1 and the
 *    next pass resumes at N. Every message carries a `uuid` derived from the
 *    session, its position and its text, so a part sent again (an answer
 *    lost in transit) is stored once by an engine that deduplicates on it.
 *  - Refusals follow the engine's error contract (`retryable`,
 *    `retry_after_ms`, `reason`): a count or size rule shrinks the parts and
 *    goes on; a message the engine refuses on its own is skipped with a
 *    warning and the count moves past it, so one bad message never blocks a
 *    session; `retryable: true` (429 included) waits as told within a small
 *    budget; anything else non-retryable stops the pass without retrying the
 *    same request. A pass is also capped in requests and wall time.
 *  - After a pass fails, the session is not tried again for a backoff that
 *    doubles from `backoffInitialMs` up to `backoffMaxMs` and resets on
 *    success (a pass that moved the count before failing restarts at the
 *    first step; the engine's `retry_after_ms` is a floor): an engine outage
 *    costs one retry envelope per window, not one per finished turn.
 *    Deleting a session ignores the backoff (it is the transcript's last
 *    chance). `onPassEnd` tells the host whether a backlog remains, for its
 *    durable catch-up.
 *  - Speakers get real identities (the user's preferred name / the oracle's
 *    preferred or configured name) so Graphiti's extractor does not pin
 *    facts to literal "user"/"assistant" nodes.
 *  - Only the conversation is sent: what the user said and the oracle's
 *    replies (`conversationReader`). The engine makes every message an episode
 *    of evidence, so a tool result, a status line before a tool call, or a
 *    reply that repeats what a memory search just returned would come back
 *    as a fact, and push real ones out of the capped user-context block. Those
 *    messages still count towards the watermark.
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
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { visibleText, visibleToUser } from '../do/transcript';
import type { Logger } from '../plugin-api/types';
import { MEMORY_ENTITY_HEADER } from '../plugins/memory/memory-entity';
import { MEMORY_SEARCH_MCP_NAME } from '../plugins/memory/memory-tools';

export interface HistoryMessage {
  /** LangChain message type: `human` | `ai` | `tool` | `system`. */
  type: string;
  content: string;
  /** Counted by the watermark but not sent (`conversationReader`). */
  notConversation?: boolean;
}

export interface MemoryEngineMessage {
  content: string;
  role_type: 'user' | 'assistant' | 'system';
  role?: string;
  name?: string;
  source_description?: string;
  /** Client message id: an engine that knows it already stores it once. */
  uuid?: string;
}

/** How a pass ended, for the host's durable catch-up (`onPassEnd`). */
export interface PassEnd {
  /** Unindexed messages remain (the pass failed, was deferred or ran out of budget). */
  backlog: boolean;
  /** The pass moved the session's count (uploaded or skipped something). */
  progressed: boolean;
  /** The engine asked for this wait before the next try. */
  retryAfterMs?: number;
  /** When the pass started (the indexer's clock): it saw the transcript as of then. */
  startedAt: number;
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
  /**
   * Called once at the end of every pass that ran (not for a call that was
   * skipped by the backoff, joined a running pass, or found indexing off).
   * Awaited; a rejection is logged and otherwise ignored.
   */
  onPassEnd?(sessionId: string, end: PassEnd): Promise<void> | void;
  logger: Logger;
  fetchImpl?: typeof fetch;
  /** Test hooks. */
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  retryDelayMs?: number;
  /** Hard timeout for the memory-engine request (default 20 s). */
  requestTimeoutMs?: number;
  /** Clock for the failure backoff and the pass budget (default `Date.now`). */
  now?: () => number;
  /** Messages per request, after the conversation filter (default `MEMORY_UPLOAD_MAX_MESSAGES`). */
  maxMessagesPerRequest?: number;
  /** JSON body bytes per request (default `MEMORY_UPLOAD_MAX_REQUEST_BYTES`). */
  maxRequestBytes?: number;
  /** UTF-8 content bytes per message (default `MEMORY_UPLOAD_MAX_MESSAGE_BYTES`). */
  maxMessageBytes?: number;
  /** Requests per pass (default 100); the rest follows on a later pass. */
  maxRequestsPerPass?: number;
  /** Wall time a pass may start new requests for (default 60 s). */
  passBudgetMs?: number;
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
 * with sockets attached). A pass starts requests for at most
 * `DEFAULT_PASS_BUDGET_MS` (60 s) and 100 requests; with a 20 s request
 * timeout, at most 30 s of engine-requested waits, two attempts 3 s apart
 * and a possible follow-up pass, its worst case is about two minutes. A
 * failed session is retried by its next trigger once its backoff has passed
 * (the watermark moved only for the parts the engine accepted).
 */
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 3_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_BACKOFF_INITIAL_MS = 60_000;
const DEFAULT_BACKOFF_MAX_MS = 3_600_000;
const DEFAULT_MAX_REQUESTS_PER_PASS = 100;
const DEFAULT_PASS_BUDGET_MS = 60_000;
/** Sessions whose resume cursor / backoff is remembered, least recent dropped first. */
const MAX_TRACKED_SESSIONS = 256;

/**
 * Messages per `POST /messages`, counted after the conversation filter: the
 * memory engine's rule (`MAX_MESSAGES_PER_REQUEST`, and the old engine's) —
 * a larger request is refused whole with 422 `MESSAGES_INVALID`.
 */
export const MEMORY_UPLOAD_MAX_MESSAGES = 50;
/** Largest message `content` the engine stores, in UTF-8 bytes (413 `EPISODE_TOO_LARGE` above it). */
export const MEMORY_UPLOAD_MAX_MESSAGE_BYTES = 16_384;
/** JSON body per request: half the engine's 1 MiB read cap (413 `BODY_TOO_LARGE` above that). */
export const MEMORY_UPLOAD_MAX_REQUEST_BYTES = 512 * 1024;
/** Pieces one transcript message is split into at most; what is left is cut, with a marker. */
export const MAX_PIECES_PER_MESSAGE = 8;
/** The engine's longest role / name / source description (`LABEL_MAX_CHARS`). */
const ENGINE_LABEL_MAX_CHARS = 500;
/** Bytes kept free in a piece for its `[part i/n] ` and cut markers. */
const MARKER_RESERVE_BYTES = 96;
/** Floors a learned limit never goes below; under them a message is skipped. */
const MIN_MESSAGE_BYTES = 1_024;
const MIN_REQUEST_BYTES = 4_096;
/** `{"messages":[` … `]}` */
const BODY_OVERHEAD_BYTES = 16;
/** Transcript messages read per page. */
const READ_PAGE_SIZE = 100;
/**
 * Waiting inside a pass when the engine says `retryable: true` (429
 * `QUEUE_FULL`, `USER_RATE_LIMITED`, …): at most this long per wait, this
 * long per pass, this many times for one part. A longer wait ends the pass
 * with the engine's `retry_after_ms` as the backoff floor.
 */
const RETRY_WAIT_MAX_MS = 10_000;
const RETRY_WAIT_TOTAL_MS = 30_000;
const RETRIES_PER_PART = 3;
const RETRY_WAIT_DEFAULT_MS = 1_000;

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

/**
 * `content` in pieces of at most `maxBytes` UTF-8 bytes each, markers
 * included: `[part i/n] ` on each piece of a split message, and a cut marker
 * on the last one when more than `maxPieces` pieces would be needed. Cuts
 * fall on a character boundary, at a line break or space near the end of a
 * piece when there is one.
 */
export function splitMessageContent(
  content: string,
  maxBytes: number,
  maxPieces: number,
): string[] {
  const bytes = utf8.encode(content);
  if (bytes.byteLength <= maxBytes) return [content];
  const budget = Math.max(1, maxBytes - MARKER_RESERVE_BYTES);
  const pieces: string[] = [];
  let start = 0;
  while (start < bytes.byteLength && pieces.length < Math.max(1, maxPieces)) {
    let end = Math.min(bytes.byteLength, start + budget);
    if (end < bytes.byteLength) {
      // Never inside a UTF-8 sequence (continuation bytes are 10xxxxxx).
      while (end > start + 1 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
      // Prefer a line break, then a space, in the last quarter of the piece.
      const floor = start + Math.floor((end - start) * 0.75);
      let soft = -1;
      for (let i = end - 1; i > floor; i -= 1) {
        if (bytes[i] === 0x0a) {
          soft = i + 1;
          break;
        }
        if (soft < 0 && bytes[i] === 0x20) soft = i + 1;
      }
      if (soft > start) end = soft;
    }
    pieces.push(utf8Decoder.decode(bytes.subarray(start, end)));
    start = end;
  }
  const cutBytes = bytes.byteLength - start;
  const total = pieces.length;
  return pieces.map((piece, i) => {
    const head = total > 1 ? `[part ${i + 1}/${total}] ` : '';
    const tail =
      i === total - 1 && cutBytes > 0
        ? ` [message cut here: ${cutBytes} more bytes not stored]`
        : '';
    return `${head}${piece}${tail}`;
  });
}

/**
 * The `uuid` of one uploaded message: a UUIDv8 (RFC 9562) over the session,
 * the message's position in the transcript (the count watermark's index),
 * its piece and its text. The same message sent again gets the same id; a
 * transcript rewritten under the count gets new ones.
 */
export async function historyMessageUuid(
  sessionId: string,
  position: number,
  piece: number,
  roleType: string,
  content: string,
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      utf8.encode(
        [
          'qiforge-history/v1',
          sessionId,
          position,
          piece,
          roleType,
          content,
        ].join('\u0000'),
      ),
    ),
  );
  const b = digest.subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x80; // version 8
  b[8] = (b[8]! & 0x3f) | 0x80; // variant 10
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A refused upload, as the engine's error contract describes it (no message content). */
export interface UploadRefusal {
  status: number;
  code?: string;
  /** The engine's verdict on sending the SAME request again; undefined when the body has none. */
  retryable?: boolean;
  retryAfterMs?: number;
  /** `reason` / `index` / `limit` / `actual` of an engine that sends them. */
  reason?: string;
  index?: number;
  limit?: number;
  actual?: number;
  /**
   * The engine's `detail` text, only from a body with a `code` (the Workers
   * engine's details carry labels and sizes). A code-less body (the old
   * engine's validation error echoes the input) is never kept.
   */
  detail?: string;
  /** Limits read from the known refusal texts. */
  countLimit?: number;
  messageByteLimit?: number;
  bodyByteLimit?: number;
}

/** What the indexer does about a refusal. */
export type RefusalKind =
  /** Too many messages in one request: send fewer. */
  | 'count'
  /** The request body is too large: send fewer bytes. */
  | 'body'
  /** One message's content is too large: split it smaller. */
  | 'message'
  /** The content was refused otherwise: narrow down to the message and skip it. */
  | 'invalid'
  /** The engine says the same request may succeed later. */
  | 'retry'
  /** Not retryable and not about the content (auth, entity, depth, misconfiguration): stop. */
  | 'stop';

function numberField(body: object, key: string): number | undefined {
  const v: unknown = Reflect.get(body, key);
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Read a non-2xx `/messages` answer into an `UploadRefusal`. */
export async function readUploadRefusal(res: Response): Promise<UploadRefusal> {
  const text = await res.text().catch(() => '');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const refusal: UploadRefusal = { status: res.status };
  const header = res.headers.get('retry-after');
  if (header !== null && /^\d+$/.test(header.trim()))
    refusal.retryAfterMs = Number(header.trim()) * 1000;
  // Limits from the engines' texts: the Workers engine's zod detail
  // ("Array must contain at most 50 element(s)", "… larger than 16384
  // bytes") and the old engine's pydantic one ("at most 50 items").
  const count = /at most (\d+) (?:element|item)/i.exec(text);
  if (count) refusal.countLimit = Number(count[1]);
  const message = /messages\[(\d+)\]\.content is larger than (\d+) bytes/i.exec(
    text,
  );
  if (message) {
    refusal.index = Number(message[1]);
    refusal.messageByteLimit = Number(message[2]);
  }
  const bodySize = /body is larger than (\d+) bytes/i.exec(text);
  if (bodySize) refusal.bodyByteLimit = Number(bodySize[1]);
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return refusal;
  const code: unknown = Reflect.get(body, 'code');
  if (typeof code === 'string') {
    refusal.code = code;
    const detail: unknown = Reflect.get(body, 'detail');
    if (typeof detail === 'string') refusal.detail = detail.slice(0, 160);
  }
  const retryable: unknown = Reflect.get(body, 'retryable');
  if (typeof retryable === 'boolean') refusal.retryable = retryable;
  const retryAfter = numberField(body, 'retry_after_ms');
  if (retryAfter !== undefined && retryAfter >= 0)
    refusal.retryAfterMs = retryAfter;
  const reason: unknown = Reflect.get(body, 'reason');
  if (typeof reason === 'string') refusal.reason = reason.slice(0, 80);
  const index = numberField(body, 'index');
  if (index !== undefined) refusal.index = index;
  const limit = numberField(body, 'limit');
  if (limit !== undefined) refusal.limit = limit;
  const actual = numberField(body, 'actual');
  if (actual !== undefined) refusal.actual = actual;
  return refusal;
}

/** Validation codes that are about the request's content (a 400 is only `BAD_JSON`). */
const CONTENT_CODES = new Set([
  'MESSAGES_INVALID',
  'BODY_INVALID',
  'BAD_JSON',
  'EPISODE_TOO_LARGE',
  'BODY_TOO_LARGE',
]);

/**
 * Sort a refusal (engine docs/API.md "Errors and retries"). Size and count
 * rules first (the `reason` field, else the code and the known texts), then
 * the engine's `retryable` (a code-less 429 / 5xx counts as retryable), then
 * content refusals; whatever is left — auth, entity, `CALLER_DEPTH`,
 * misconfiguration — must not be retried as is, nor skipped past.
 */
export function classifyUploadRefusal(r: UploadRefusal): RefusalKind {
  const reason = r.reason ?? '';
  if (reason.startsWith('too_many:messages')) return 'count';
  if (
    reason === 'body_too_large' ||
    r.code === 'BODY_TOO_LARGE' ||
    r.bodyByteLimit !== undefined
  )
    return 'body';
  if (
    reason.startsWith('too_large:messages') ||
    r.code === 'EPISODE_TOO_LARGE' ||
    r.messageByteLimit !== undefined
  )
    return 'message';
  const contentScoped =
    r.status === 413 ||
    (r.status === 422 && (r.code === undefined || CONTENT_CODES.has(r.code))) ||
    (r.status === 400 && r.code === 'BAD_JSON');
  if (contentScoped && r.countLimit !== undefined) return 'count';
  if (r.status === 413) return 'body';
  if (r.retryable === true) return 'retry';
  if (r.retryable === undefined && (r.status === 429 || r.status >= 500))
    return 'retry';
  if (contentScoped) return 'invalid';
  return 'stop';
}

/** Ends a pass at once, without the outer retry (a non-retryable refusal, or a wait longer than a pass may hold). */
class UploadStop extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'UploadStop';
  }
}

function truncateLabel(label: string): string {
  return label.length > ENGINE_LABEL_MAX_CHARS
    ? label.slice(0, ENGINE_LABEL_MAX_CHARS)
    : label;
}

function bodyBytes(message: MemoryEngineMessage): number {
  // The message plus its separating comma.
  return utf8.encode(JSON.stringify(message)).byteLength + 1;
}

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

/** Text that parses as a JSON object or list: a tool's output, not a reply. */
function isJsonDocument(text: string): boolean {
  const start = text.trimStart()[0];
  if (start !== '{' && start !== '[') return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads a transcript in order, one reader per read, and turns each message
 * into what the indexer takes. A turn's memory search is seen before its reply,
 * so that reply is known to repeat what memory returned, which must not go
 * back in as new evidence. A read that starts in the middle of a turn has not
 * seen the search; a pass normally starts at a turn's end.
 */
export function conversationReader(): (message: BaseMessage) => HistoryMessage {
  let readMemory = false;
  return (message) => {
    const content = visibleText(message);
    const calls = AIMessage.isInstance(message)
      ? (message.tool_calls ?? [])
      : [];
    if (message.type === 'human') readMemory = false;
    if (calls.some((call) => call.name === MEMORY_SEARCH_MCP_NAME))
      readMemory = true;
    const conversation =
      visibleToUser(message) &&
      (message.type === 'human' ||
        (calls.length === 0 && !readMemory && !isJsonDocument(content)));
    return {
      type: message.type,
      content,
      ...(conversation ? {} : { notConversation: true }),
    };
  };
}

/**
 * One transcript message as the engine takes it, or null when it is not
 * sent (a tool result, a flagged message, an empty one: the engine rejects
 * empty episodes and has no tool role). Labels are cut to the engine's
 * 500-character limit, which would otherwise refuse the whole request.
 */
function toEngineMessage(
  message: HistoryMessage,
  sessionTitle: string,
  userSpeakerLabel: string,
  oracleSpeakerLabel: string,
): MemoryEngineMessage | null {
  if (
    message.type === 'tool' ||
    message.notConversation ||
    message.content.trim().length === 0
  )
    return null;
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
    default:
      role_type = 'user';
      label = userSpeakerLabel;
  }
  const name = truncateLabel(label);
  return {
    content: message.content,
    role_type,
    role: name,
    name,
    source_description: truncateLabel(`Chat Session: ${sessionTitle}`),
  };
}

/** Node's `transformMessagesToMemoryEngineFormat`, verbatim in mapping. */
export function transformMessagesToMemoryEngineFormat(
  messages: readonly HistoryMessage[],
  sessionTitle: string,
  userSpeakerLabel: string,
  oracleSpeakerLabel: string,
): MemoryEngineMessage[] {
  const out: MemoryEngineMessage[] = [];
  for (const message of messages) {
    const mapped = toEngineMessage(
      message,
      sessionTitle,
      userSpeakerLabel,
      oracleSpeakerLabel,
    );
    if (mapped) out.push(mapped);
  }
  return out;
}

/** Transcript messages that go up in one request, and what they become. */
interface Part {
  /** Whole transcript messages, oldest first (the count moves past all of them on acceptance). */
  entries: HistoryEntry[];
  /** What is sent for them (empty when none of them is conversation). */
  messages: MemoryEngineMessage[];
  /** For each message, the index of its entry in `entries`. */
  entryOf: number[];
  /** JSON body size. */
  bytes: number;
  /** Largest message content, UTF-8 bytes. */
  largest: number;
}

/** Bookkeeping of one pass across its attempts. */
interface PassState {
  startedAt: number;
  /** The stored count when the pass began. */
  startCount: number;
  /** The count now (moves on each accepted part and each skip). */
  count: number;
  requests: number;
  accepted: number;
  sent: number;
  skipped: number;
  waitedMs: number;
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

  /**
   * The request rules this indexer keeps to: the configured limits,
   * lowered (never raised) for the rest of its life when the engine refuses
   * a request by a smaller one.
   */
  private maxMessages: number;

  private maxRequestBytes: number;

  private maxMessageBytes: number;

  private readonly maxRequestsPerPass: number;

  private readonly passBudgetMs: number;

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
    this.maxMessages = Math.max(
      1,
      Math.floor(deps.maxMessagesPerRequest ?? MEMORY_UPLOAD_MAX_MESSAGES),
    );
    this.maxRequestBytes = Math.max(
      MIN_REQUEST_BYTES,
      deps.maxRequestBytes ?? MEMORY_UPLOAD_MAX_REQUEST_BYTES,
    );
    this.maxMessageBytes = Math.max(
      MIN_MESSAGE_BYTES,
      deps.maxMessageBytes ?? MEMORY_UPLOAD_MAX_MESSAGE_BYTES,
    );
    this.maxRequestsPerPass = Math.max(
      1,
      deps.maxRequestsPerPass ?? DEFAULT_MAX_REQUESTS_PER_PASS,
    );
    this.passBudgetMs = deps.passBudgetMs ?? DEFAULT_PASS_BUDGET_MS;
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

  /** Whether a pass can run at all: an engine URL and the oracle's entity DID. */
  get active(): boolean {
    return this.enabled && Boolean(this.deps.entityDid);
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
    const pass: PassState = {
      startedAt: this.now(),
      startCount: -1,
      count: -1,
      requests: 0,
      accepted: 0,
      sent: 0,
      skipped: 0,
      waitedMs: 0,
    };
    let retryAfterMs: number | undefined;
    let stopped = false;
    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      try {
        const { outcome, backlog } = await this.processOnce(
          sessionId,
          entityDid,
          pass,
        );
        if (outcome === 'processed') this.backoff.delete(sessionId);
        await this.reportPassEnd(sessionId, {
          backlog,
          progressed: pass.count > pass.startCount && pass.startCount >= 0,
          startedAt: pass.startedAt,
        });
        return outcome;
      } catch (err) {
        if (err instanceof UploadStop) {
          logger.warn(
            `[history-indexer] stopping the pass for session ${sessionId}: ${err.message}`,
          );
          retryAfterMs = err.retryAfterMs;
          stopped = true;
          break;
        }
        logger.warn(
          `[history-indexer] attempt ${attempt}/${this.maxRetries} failed for session ${sessionId}: ${describe(err)}`,
        );
        if (attempt < this.maxRetries) await this.sleep(this.retryDelayMs);
      }
    }
    const progressed = pass.startCount >= 0 && pass.count > pass.startCount;
    const previous = this.backoff.get(sessionId);
    // A pass that moved the count was not a dead engine: start the backoff
    // over. The engine's own wait is a floor.
    const delayMs = Math.max(
      previous && !progressed
        ? Math.min(previous.delayMs * 2, this.backoffMaxMs)
        : this.backoffInitialMs,
      retryAfterMs ?? 0,
    );
    remember(this.backoff, sessionId, {
      until: this.now() + delayMs,
      delayMs: Math.min(delayMs, this.backoffMaxMs),
    });
    logger.error(
      `[history-indexer] giving up on session ${sessionId} ${stopped ? 'for now' : `after ${this.maxRetries} attempts`} (lastProcessedCount ${pass.startCount} → ${pass.count}, ${pass.accepted} parts accepted this pass); next try in ${Math.round(delayMs / 1000)}s at the earliest`,
    );
    await this.reportPassEnd(sessionId, {
      backlog: true,
      progressed,
      startedAt: pass.startedAt,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
    return 'failed';
  }

  private async reportPassEnd(sessionId: string, end: PassEnd): Promise<void> {
    if (!this.deps.onPassEnd) return;
    try {
      await this.deps.onPassEnd(sessionId, end);
    } catch (err) {
      this.deps.logger.warn(
        `[history-indexer] onPassEnd failed for session ${sessionId}: ${describe(err)}`,
      );
    }
  }

  private async processOnce(
    sessionId: string,
    entityDid: string,
    pass: PassState,
  ): Promise<{ outcome: IndexOutcome; backlog: boolean }> {
    const { deps } = this;
    const { logger } = deps;
    const memoryEngineUrl = deps.memoryEngineUrl!.replace(/\/+$/, '');
    // Nothing a later pass could do differently: no backlog to keep.
    const skipped = { outcome: 'skipped' as const, backlog: false };

    const session = await deps.getSession(sessionId);
    if (!session) {
      logger.warn(`[history-indexer] session ${sessionId} not found, skipping`);
      return skipped;
    }

    const lastProcessedCount = session.lastProcessedCount ?? 0;
    if (pass.startCount < 0) pass.startCount = lastProcessedCount;
    pass.count = lastProcessedCount;
    const tail = this.tailReader(sessionId, lastProcessedCount);
    const first = await tail.next();
    if (!first) {
      logger.log(
        `[history-indexer] no new messages for session ${sessionId} (lastProcessedCount: ${lastProcessedCount})`,
      );
      return skipped;
    }
    tail.unread([first]);

    // Only now (a gateway call for a session without a room of its own).
    const roomId =
      session.roomId ?? (await deps.resolveUserRoom())?.roomId ?? null;
    if (!roomId) {
      logger.warn(
        `[history-indexer] no oracle room for session ${sessionId}, skipping`,
      );
      return skipped;
    }

    if (!deps.ucan.hasSigningKey()) {
      logger.warn(
        `[history-indexer] no UCAN signing key; skipping memory engine processing for session ${sessionId}`,
      );
      return skipped;
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
      // An engine whose DID document cannot be read is unreachable, not a
      // missing delegation: a failure, so the backlog and backoff stay.
      if (!memoryDid)
        throw new Error('could not resolve the memory engine DID');
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
    const title = session.title ?? '';
    const url = `${memoryEngineUrl}/messages`;
    const headers = {
      'X-Auth-Type': 'ucan',
      [MEMORY_ENTITY_HEADER]: entityDid,
      'x-room-id': roomId,
      'Content-Type': 'application/json',
    };
    let uploaded = false;
    // Narrowing down a refused part: at most `entryLimit` transcript
    // messages per part until the count passes `narrowUntil`.
    let entryLimit = Infinity;
    let narrowUntil = 0;
    /** `pass.accepted` at the last skip (or the attempt's start): a skip needs a later acceptance. */
    let acceptedAtLastSkip = pass.accepted;
    try {
      for (;;) {
        if (
          pass.requests >= this.maxRequestsPerPass ||
          this.now() - pass.startedAt >= this.passBudgetMs
        ) {
          const more = await tail.next();
          if (!more) break;
          tail.unread([more]);
          logger.log(
            `[history-indexer] session ${sessionId}: pass budget spent (${pass.requests} requests, ${Math.round((this.now() - pass.startedAt) / 1000)}s; lastProcessedCount ${pass.startCount} → ${pass.count}); the rest follows on the next pass`,
          );
          return { outcome: 'processed', backlog: true };
        }
        if (pass.count >= narrowUntil) entryLimit = Infinity;
        const part = await this.nextPart(
          tail,
          sessionId,
          pass.count,
          title,
          labels,
          entryLimit,
        );
        if (part.entries.length === 0) break;
        if (part.messages.length === 0) {
          // Nothing in it is conversation: the count moves past it.
          await this.advance(sessionId, part.entries, pass);
          continue;
        }
        const verdict = await this.send(
          url,
          headers,
          part,
          pass,
          sessionId,
          mint,
        );
        if (verdict.kind === 'no-invocation') {
          // Node: a failed mint is a warn + skip, not a retry — the user
          // simply has not delegated `ixo:memory` to this oracle (yet).
          if (pass.accepted === 0) {
            logger.warn(
              `[history-indexer] no memory engine invocation for session ${sessionId}; skipping`,
            );
            return skipped;
          }
          throw new Error('no memory engine invocation for the next part');
        }
        if (verdict.kind === 'accepted') {
          uploaded = true;
          pass.accepted += 1;
          pass.sent += part.messages.length;
          await this.advance(sessionId, part.entries, pass);
          if (Number.isFinite(entryLimit)) entryLimit *= 2;
          logger.log(
            `[history-indexer] session ${sessionId}: part ${pass.accepted} accepted (${part.messages.length} messages from ${part.entries.length} transcript messages, ${part.bytes} bytes; lastProcessedCount → ${pass.count})`,
          );
          continue;
        }
        const { refusal } = verdict;
        const n = part.messages.length;
        let kind: RefusalKind = verdict.kind;
        if (kind === 'count') {
          const limit = Math.min(
            n - 1,
            refusal.limit ?? refusal.countLimit ?? Math.floor(n / 2),
          );
          if (limit >= 1) {
            this.maxMessages = Math.min(this.maxMessages, limit);
            this.warnRefusal(
              sessionId,
              refusal,
              kind,
              part,
              `sending at most ${this.maxMessages} messages per request from now on`,
            );
            tail.unread(part.entries);
            continue;
          }
          kind = 'invalid';
        }
        if (kind === 'body') {
          // Strictly smaller, by a tenth at least, so a re-cut part differs
          // from the refused one; at the floor the message is invalid.
          const engineLimit = refusal.limit ?? refusal.bodyByteLimit;
          const limit = Math.min(
            this.maxRequestBytes,
            engineLimit !== undefined
              ? Math.min(engineLimit, Math.floor(part.bytes * 0.9))
              : Math.floor(part.bytes / 2),
          );
          if (limit >= MIN_REQUEST_BYTES && limit < this.maxRequestBytes) {
            this.maxRequestBytes = limit;
            this.warnRefusal(
              sessionId,
              refusal,
              kind,
              part,
              `sending at most ${limit} bytes per request from now on`,
            );
            tail.unread(part.entries);
            continue;
          }
          kind = 'invalid';
        }
        if (kind === 'message') {
          const engineLimit = refusal.limit ?? refusal.messageByteLimit;
          const limit = Math.min(
            this.maxMessageBytes,
            engineLimit !== undefined
              ? Math.min(engineLimit, Math.floor(part.largest * 0.9))
              : Math.floor(part.largest / 2),
          );
          if (limit >= MIN_MESSAGE_BYTES && limit < this.maxMessageBytes) {
            this.maxMessageBytes = limit;
            this.warnRefusal(
              sessionId,
              refusal,
              kind,
              part,
              `splitting messages at ${limit} bytes from now on`,
            );
            tail.unread(part.entries);
            continue;
          }
          kind = 'invalid';
        }
        if (part.entries.length > 1) {
          // Find the message the engine will not take: the one it names,
          // else halve the part until it is alone.
          const named =
            refusal.index !== undefined
              ? part.entryOf[refusal.index]
              : undefined;
          entryLimit =
            named !== undefined
              ? Math.max(1, named)
              : Math.ceil(part.entries.length / 2);
          narrowUntil = pass.count + part.entries.length;
          this.warnRefusal(
            sessionId,
            refusal,
            kind,
            part,
            `narrowing down: the next request holds at most ${entryLimit} transcript messages`,
          );
          tail.unread(part.entries);
          continue;
        }
        // One transcript message refused on its own. Skip it only with
        // evidence that it is the message and not every request: a request
        // accepted since the last skip, else the messages after it accepted
        // in one request. Without that (an engine that refuses everything
        // for a shared reason) the pass stops and skips nothing.
        const bad = part;
        let confirmation: Part | null = null;
        if (pass.accepted === acceptedAtLastSkip) {
          const probe = await this.nextPart(
            tail,
            sessionId,
            pass.count + 1,
            title,
            labels,
            Infinity,
          );
          const verdictAfter =
            probe.messages.length > 0
              ? await this.send(url, headers, probe, pass, sessionId, mint)
              : null;
          if (verdictAfter?.kind !== 'accepted') {
            tail.unread(probe.entries);
            this.warnRefusal(
              sessionId,
              refusal,
              kind,
              bad,
              probe.messages.length === 0
                ? 'stopping the pass: nothing after this message to tell whether the engine refuses it or every request; nothing skipped'
                : 'stopping the pass: the messages after it were refused too, so the refusal is not about this message; nothing skipped',
            );
            throw new UploadStop(
              `the memory engine refuses the session's messages (${describeRefusal(refusal)})`,
            );
          }
          confirmation = probe;
        }
        this.warnRefusal(
          sessionId,
          refusal,
          kind,
          bad,
          `skipping transcript message ${pass.count} (${bad.entries[0]!.message.type}) so the rest of the session is stored`,
        );
        pass.skipped += 1;
        await this.advance(sessionId, bad.entries, pass);
        if (confirmation) {
          uploaded = true;
          pass.accepted += 1;
          pass.sent += confirmation.messages.length;
          await this.advance(sessionId, confirmation.entries, pass);
          logger.log(
            `[history-indexer] session ${sessionId}: part ${pass.accepted} accepted (${confirmation.messages.length} messages from ${confirmation.entries.length} transcript messages, ${confirmation.bytes} bytes; lastProcessedCount → ${pass.count})`,
          );
        }
        acceptedAtLastSkip = pass.accepted;
        // The refused message is behind us: full parts again (another bad
        // one is narrowed down the same way).
        entryLimit = Infinity;
        narrowUntil = 0;
      }
    } finally {
      // Once per attempt, also when a later part failed: what the engine
      // accepted already changes what the prefetch would recall.
      if (uploaded) deps.onIndexed?.(roomId);
    }
    logger.log(
      pass.accepted > 1 || pass.skipped > 0
        ? `[history-indexer] session ${sessionId}: backlog done, ${pass.sent} messages in ${pass.accepted} parts${pass.skipped > 0 ? `, ${pass.skipped} transcript messages skipped` : ''} (lastProcessedCount ${pass.startCount} → ${pass.count})`
        : `[history-indexer] indexed session ${sessionId} into the memory engine (lastProcessedCount ${pass.startCount} → ${pass.count})`,
    );
    return { outcome: 'processed', backlog: false };
  }

  /** The count moves past `entries` (an accepted, empty or skipped part). */
  private async advance(
    sessionId: string,
    entries: readonly HistoryEntry[],
    pass: PassState,
  ): Promise<void> {
    pass.count += entries.length;
    await this.deps.setProcessedCount(sessionId, pass.count);
    remember(this.cursors, sessionId, {
      count: pass.count,
      cursor: entries[entries.length - 1]!.cursor,
    });
  }

  /**
   * Send one part. Waits and resends (fresh invocation each time) while the
   * engine says `retryable: true`, within the pass's wait budget; a plain
   * 5xx or a network failure throws for the pass's attempts; a
   * non-retryable refusal that is not about the content stops the pass.
   */
  private async send(
    url: string,
    headers: Record<string, string>,
    part: Part,
    pass: PassState,
    sessionId: string,
    mint: () => Promise<string | null>,
  ): Promise<
    | { kind: 'accepted' }
    | { kind: 'no-invocation' }
    | {
        kind: Exclude<RefusalKind, 'retry' | 'stop'>;
        refusal: UploadRefusal;
      }
  > {
    const body = JSON.stringify({ messages: part.messages });
    for (let tries = 1; ; tries += 1) {
      const invocation = await mint();
      if (!invocation) return { kind: 'no-invocation' };
      pass.requests += 1;
      // A timer of our own, cleared when the request ends: a pending
      // `AbortSignal.timeout` would keep the object resident for its span.
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error('memory engine request timed out')),
        this.requestTimeoutMs,
      );
      let refusal: UploadRefusal;
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { ...headers, Authorization: `Bearer ${invocation}` },
          body,
          signal: controller.signal,
        });
        if (res.ok) {
          await res.body?.cancel().catch(() => undefined);
          return { kind: 'accepted' };
        }
        refusal = await readUploadRefusal(res);
      } finally {
        clearTimeout(timer);
      }
      const kind = classifyUploadRefusal(refusal);
      if (kind === 'stop') {
        this.warnRefusal(
          sessionId,
          refusal,
          kind,
          part,
          'stopping the pass: not retryable and not about the messages',
        );
        throw new UploadStop(
          `the memory engine refused the upload (${describeRefusal(refusal)})`,
        );
      }
      if (kind !== 'retry') return { kind, refusal };
      const hinted =
        refusal.retryable === true ||
        refusal.retryAfterMs !== undefined ||
        refusal.status === 429;
      if (!hinted)
        throw new Error(
          `memory engine rejected the upload (${describeRefusal(refusal)})`,
        );
      const waitMs =
        refusal.retryAfterMs ?? RETRY_WAIT_DEFAULT_MS * 2 ** (tries - 1);
      if (
        tries >= RETRIES_PER_PART ||
        waitMs > RETRY_WAIT_MAX_MS ||
        pass.waitedMs + waitMs > RETRY_WAIT_TOTAL_MS
      ) {
        this.warnRefusal(
          sessionId,
          refusal,
          kind,
          part,
          `deferring the rest of the session by ${Math.round(waitMs / 1000)}s at least`,
        );
        throw new UploadStop(
          `the memory engine asked to wait (${describeRefusal(refusal)})`,
          waitMs,
        );
      }
      this.warnRefusal(
        sessionId,
        refusal,
        kind,
        part,
        `sending the same part again in ${waitMs} ms`,
      );
      pass.waitedMs += waitMs;
      await this.sleep(waitMs);
    }
  }

  /** The warn line for a refused upload: the engine's verdict, counts and sizes, what happens next. Never content. */
  private warnRefusal(
    sessionId: string,
    refusal: UploadRefusal,
    kind: RefusalKind,
    part: Part,
    action: string,
  ): void {
    this.deps.logger.warn(
      `[history-indexer] memory engine refused an upload for session ${sessionId} (${describeRefusal(refusal)}; rule=${kind}): ${part.messages.length} messages from ${part.entries.length} transcript messages, ${part.bytes} bytes, largest message ${part.largest} bytes; ${action}`,
    );
  }

  /**
   * The next part: whole transcript messages, oldest first, while their
   * engine messages stay within the message count and body size (a single
   * transcript message is made to fit on its own), and at most `entryLimit`
   * transcript messages.
   */
  private async nextPart(
    tail: TailReader,
    sessionId: string,
    startCount: number,
    title: string,
    labels: SpeakerLabels,
    entryLimit: number,
  ): Promise<Part> {
    const part: Part = {
      entries: [],
      messages: [],
      entryOf: [],
      bytes: BODY_OVERHEAD_BYTES,
      largest: 0,
    };
    while (part.entries.length < entryLimit) {
      const entry = await tail.next();
      if (!entry) break;
      const messages = await this.engineMessagesFor(
        entry.message,
        sessionId,
        startCount + part.entries.length,
        title,
        labels,
      );
      let bytes = 0;
      for (const m of messages) bytes += bodyBytes(m);
      if (
        part.entries.length > 0 &&
        (part.messages.length + messages.length > this.maxMessages ||
          part.bytes + bytes > this.maxRequestBytes)
      ) {
        tail.unread([entry]);
        break;
      }
      const index = part.entries.length;
      part.entries.push(entry);
      for (const m of messages) {
        part.messages.push(m);
        part.entryOf.push(index);
        part.largest = Math.max(
          part.largest,
          utf8.encode(m.content).byteLength,
        );
      }
      part.bytes += bytes;
    }
    return part;
  }

  /**
   * What one transcript message becomes: nothing (not conversation), one
   * engine message, or up to `MAX_PIECES_PER_MESSAGE` marked pieces (never
   * more than a request may hold), each with its `uuid`. A message that
   * would not fit one request body is cut harder.
   */
  private async engineMessagesFor(
    message: HistoryMessage,
    sessionId: string,
    position: number,
    title: string,
    labels: SpeakerLabels,
  ): Promise<MemoryEngineMessage[]> {
    const base = toEngineMessage(message, title, labels.user, labels.oracle);
    if (!base) return [];
    const maxPieces = Math.max(
      1,
      Math.min(MAX_PIECES_PER_MESSAGE, this.maxMessages),
    );
    let pieceBytes = this.maxMessageBytes;
    for (;;) {
      const pieces = splitMessageContent(base.content, pieceBytes, maxPieces);
      const out = await Promise.all(
        pieces.map(
          async (content, piece): Promise<MemoryEngineMessage> => ({
            ...base,
            content,
            uuid: await historyMessageUuid(
              sessionId,
              position,
              piece,
              base.role_type,
              content,
            ),
          }),
        ),
      );
      let total = BODY_OVERHEAD_BYTES;
      for (const m of out) total += bodyBytes(m);
      if (total <= this.maxRequestBytes || pieceBytes <= MIN_MESSAGE_BYTES)
        return out;
      pieceBytes = Math.max(MIN_MESSAGE_BYTES, Math.floor(pieceBytes / 2));
    }
  }

  /**
   * Reads the unindexed tail one transcript message at a time (paged
   * underneath); `unread` hands messages back for the next part. It resumes
   * from the remembered cursor when that cursor belongs to the stored
   * watermark; otherwise (a fresh object, a count moved elsewhere, a cursor
   * the store no longer knows) it scans from the start and skips the
   * `watermark` messages already indexed.
   */
  private tailReader(sessionId: string, watermark: number): TailReader {
    const known = this.cursors.get(sessionId);
    let cursor: string | null =
      known && known.count === watermark ? known.cursor : null;
    let skip = cursor === null ? watermark : 0;
    /** Messages handed out so far: the stored count plus what the caller holds. */
    let consumed = watermark;
    let exhausted = false;
    /** Read but not handed out (or handed back). */
    const buffer: HistoryEntry[] = [];
    const fill = async (): Promise<void> => {
      while (buffer.length === 0 && !exhausted) {
        const page = await this.deps.readMessages(
          sessionId,
          cursor,
          READ_PAGE_SIZE,
        );
        if (page === null) {
          if (cursor === null) {
            exhausted = true;
            break;
          }
          // The transcript was rewritten under the cursor: start over and
          // skip what is handed out so far.
          this.cursors.delete(sessionId);
          cursor = null;
          skip = consumed;
          continue;
        }
        for (const entry of page.entries) {
          cursor = entry.cursor;
          if (skip > 0) {
            skip -= 1;
            continue;
          }
          buffer.push(entry);
        }
        if (!page.more || page.entries.length === 0) exhausted = true;
      }
    };
    return {
      next: async () => {
        if (buffer.length === 0) await fill();
        const entry = buffer.shift();
        if (!entry) return null;
        consumed += 1;
        return entry;
      },
      unread: (entries) => {
        buffer.unshift(...entries);
        consumed -= entries.length;
      },
    };
  }
}

interface TailReader {
  next(): Promise<HistoryEntry | null>;
  unread(entries: readonly HistoryEntry[]): void;
}

function describeRefusal(r: UploadRefusal): string {
  return [
    `${r.status}${r.code ? ` ${r.code}` : ''}`,
    ...(r.reason ? [`reason=${r.reason}`] : []),
    `retryable=${r.retryable ?? 'unset'}`,
    ...(r.retryAfterMs !== undefined
      ? [`retry_after_ms=${r.retryAfterMs}`]
      : []),
    ...(r.limit !== undefined ? [`limit=${r.limit}`] : []),
    ...(r.actual !== undefined ? [`actual=${r.actual}`] : []),
    ...(r.detail ? [`detail="${r.detail}"`] : []),
  ].join(' ');
}

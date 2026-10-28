/* eslint-disable no-console -- console IS the logger on Workers (Logs/observability). */
import type { z } from 'zod';
import type { DoSqliteDatabase } from '../sqlite/database';
import { UNTITLED_SESSION } from '../sqlite/sessions-store';
import type { RunRecord } from '../do/run-store';
import type { TurnIdentity, TurnRequest } from '../do/contracts';
import { parseReplyPlan, planText } from '../delivery/schema';
import type { ReplyPlan } from '../delivery/types';
import {
  ChannelError,
  type ChannelControlResult,
  StoredChannelControlResult,
  type ChannelControlInput,
  type ChannelReplyContext,
  channelRequestHash,
  channelRunId,
  StaleSessionError,
  type ChannelTopic,
  type ChannelTurnInput,
  type ChannelTurnResponse,
} from './contract';
import { isRoomForbidden } from './failures';
import {
  ambiguousThreadText,
  channelSessionDecision,
  CHANNEL_THREAD_LIMIT,
  decideChannelRoute,
  routeAssignmentSchema,
  selectChannelCandidates,
  type ChannelRouteAssignment,
  type ChannelRouteObservation,
  type ChannelRoutingOptions,
  type ChannelThreadCandidate,
} from './routing';

interface ReceiptRow extends Record<string, string | number | null> {
  binding_id: string;
  request_id: string;
  request_hash: string;
  run_id: string;
  session_id: string | null;
  /** 1 once the user message was mirrored (or there is none to mirror). */
  user_mirrored: number;
  /**
   * 0 while the reply is owed, 1 once it was mirrored into the user's oracle
   * room, 2 when the run ended without a reply to mirror.
   */
  reply_mirrored: number;
  /** 1 while a mirror of this request is owed to the user's oracle room. */
  mirror_pending: number;
  /** Failed mirror attempts since the last success. */
  mirror_failures: number;
  /** Epoch ms before which an owed mirror is not tried again (null = now). */
  mirror_retry_at: number | null;
  /** Epoch ms the receipt was written (rows from before the column: its migration). */
  created_at: number | null;
  routing_json: string | null;
}

/**
 * An owed mirror is abandoned after this many failed attempts, or at once
 * when the homeserver refuses the oracle in the room. The retries back off
 * from one minute, doubling, to at most an hour (about three hours in all).
 */
export const CHANNEL_MIRROR_MAX_FAILURES = 8;
export const CHANNEL_MIRROR_RETRY_BASE_MS = 60_000;
const CHANNEL_MIRROR_RETRY_MAX_MS = 3_600_000;

/**
 * How long a receipt whose request never started a run, and the tombstone
 * of a pruned run, are kept before the housekeeping alarm removes them.
 */
export const CHANNEL_RECORD_RETENTION_MS = 7 * 24 * 3600 * 1000;
/** Rows removed per housekeeping tick and table; a full batch re-arms soon. */
export const CHANNEL_PRUNE_BATCH = 200;
/** Receipts with an owed mirror read per mirror pass. */
const MIRROR_SCAN_BATCH = 200;

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'finished',
  'aborted',
  'interrupted',
  'failed',
]);

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * How long one routed submission may hold its binding's lane. Classifier
 * and Matrix calls are bounded on their own; this keeps one that hangs
 * anyway from holding every later message of the binding.
 */
const ROUTING_LANE_DEADLINE_MS = 20_000;

/**
 * A JSON column written by this module, read back. A row that no longer
 * parses (written by another version, say) is treated as absent instead of
 * failing every request that reads it; the warning names only the kind.
 */
function readStored<T>(
  schema: z.ZodType<T>,
  raw: string,
  kind: string,
): T | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = undefined;
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  console.warn(`[channels] ignoring an unreadable stored ${kind}`);
  return undefined;
}

/** `work`, refused with a 503 once `ms` passed; the timer never outlives it. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ChannelError(
                503,
                'The channel is busy with an earlier message; try again',
                'unavailable',
              ),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** What the sessions store holds about one session. */
export interface ChannelSessionInfo {
  /** The stored title, if any: 'Untitled' and blank ones count as none. */
  title: string | null;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms of the last activity. */
  updatedAt: number;
}

/** The most sessions `topics` lists. */
const CHANNEL_TOPICS_LIMIT = 20;
/** The most binding rows `topics` reads, the most recently bound first: the rest are not listed. */
const CHANNEL_TOPICS_SCAN = 200;
/** Code points a title or a last line may have on the wire. */
const CHANNEL_TOPIC_LINE_LIMIT = 200;
const CHANNEL_TITLE_LIMIT = 80;
/** Receipts looked through, newest first, for one that is not a routing question. */
const CHANNEL_TOPIC_LOOKBACK = 5;
/** Ids per statement: a Durable Object binds at most 100 parameters. */
const CHANNEL_IDS_PER_STATEMENT = 50;

function clipCodePoints(text: string, limit: number): string {
  const points = Array.from(text);
  return points.length > limit ? points.slice(0, limit).join('') : text;
}

/**
 * Text as a single line of plain characters: whitespace runs become one
 * space; control, format and line or paragraph separator characters (bidi
 * overrides, zero-width marks) are removed.
 */
function plainLine(text: string): string {
  return text
    .replace(/\s+/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** A line of a conversation as `topics` shows it, or null when nothing is left. */
function topicLine(text: string | null | undefined): string | null {
  const line = clipCodePoints(plainLine(text ?? ''), CHANNEL_TOPIC_LINE_LIMIT);
  return line.length > 0 ? line : null;
}

function isPlaceholderTitle(title: string): boolean {
  return title.toLowerCase() === UNTITLED_SESSION.toLowerCase();
}

/** A stored title as the wire carries it: null when untitled, at most 200 code points. */
function wireTitle(title: string | null | undefined): string | null {
  const line = plainLine(title ?? '');
  return line.length > 0 && !isPlaceholderTitle(line)
    ? clipCodePoints(line, CHANNEL_TOPIC_LINE_LIMIT)
    : null;
}

/**
 * A person's new title: one plain line of 1..80 code points that is not the
 * placeholder, which the auto-titler would overwrite.
 */
function cleanTitle(title: string): string {
  const cleaned = clipCodePoints(plainLine(title), CHANNEL_TITLE_LIMIT);
  if (cleaned.length === 0 || isPlaceholderTitle(cleaned))
    throw new ChannelError(400, 'Invalid title', 'invalid_request');
  return cleaned;
}

export interface ChannelTurnsHost {
  routing?: ChannelRoutingOptions;
  createSession(identity: TurnIdentity, markerTxnId: string): Promise<string>;
  /**
   * Throws `StaleSessionError` when the object holds no such session (it
   * was deleted), any other `ChannelError` when it is not the user's
   * session in the encrypted oracle room.
   */
  assertSession(identity: TurnIdentity, sessionId: string): Promise<void>;
  /**
   * Throws a `ChannelError` (428 `delegation_required`) when the user has no
   * usable delegation for this oracle: none, or one too close to expiry.
   */
  requireDelegation(identity: TurnIdentity): Promise<void>;
  /**
   * Abort the named runs (unknown or ended ones are skipped). Signals all
   * of them first, then waits at most one shared grace; a run may still be
   * winding down when it resolves.
   */
  stopRuns(runIds: readonly string[]): Promise<void>;
  /** The sessions store's rows for `sessionIds`; a session it holds none for (deleted) is absent. */
  describeSessions(
    sessionIds: readonly string[],
  ): Promise<Map<string, ChannelSessionInfo>>;
  /** Set a session's title, replacing any; false when it holds no such session. */
  renameSession(sessionId: string, title: string): Promise<boolean>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  /** The Reply Plan (JSON) a finished run was built into, if any. */
  getPlan(runId: string): Promise<string | null>;
  wasPruned(runId: string): Promise<boolean>;
  begin(runId: string, request: TurnRequest): Promise<RunRecord>;
  /** The turn a run was admitted with, read back from its stored request. */
  requestOf(record: RunRecord): TurnRequest;
  /** Post one message into the user's oracle room; rejects when it could not. */
  mirror(
    request: TurnRequest,
    text: string,
    author: 'user' | 'oracle',
  ): Promise<void>;
  changed(): Promise<void>;
  /** Wake the object at `at` (epoch ms) to try an owed mirror again. */
  scheduleRetry(at: number): void;
  /** Keep background work alive past the request that started it. */
  keepAlive(work: Promise<unknown>): void;
  /** Remove tombstones of runs pruned before `before` (epoch ms), at most `limit`. */
  pruneTombstones(before: number, limit: number): Promise<number>;
  /** The clock (epoch ms); `Date.now` when absent. */
  now?(): number;
}

/** What admission found under the lock, before any Matrix I/O. */
type Received =
  | { kind: 'run'; response: ChannelTurnResponse }
  | {
      kind: 'new';
      sessionId: string | null;
      /** The receipt's stored route assignment, as step 1 read it. */
      routingJson: string | null;
    };
interface PreparedChannelTurn {
  sessionId: string;
  routing?: ChannelRouteAssignment;
}

/**
 * Durable channel requests. A request is admitted in three steps, so the
 * per-object admission lock never waits on Matrix:
 *
 * 1. under the lock, SQLite only: the receipt, and the run if the request
 *    started one already (a poll ends here);
 * 2. outside it: the delegation check (which may read room state), the
 *    session marker of a binding's first message and the session check
 *    (gateway RPCs and a homeserver read);
 * 3. under the lock again, SQLite only: bind the session and begin the run.
 *
 * The user's oracle room mirrors (the user message, then the reply) are owed by
 * the receipt and sent in the background, never awaited by a turn or a poll.
 */
export class ChannelTurns {
  private admission: Promise<unknown> = Promise.resolve();
  private setupPromise: Promise<void> | undefined;
  /**
   * The session being opened for a binding's first message: concurrent
   * first messages of one binding share it instead of each sending a
   * marker. Removed once a session is bound, or when opening fails.
   */
  private readonly opening = new Map<string, Promise<string>>();
  /** The mirror pass in progress, if any (single-flight). */
  private draining: Promise<void> | null = null;
  /** A pass was asked for while one ran: run another when it ends. */
  private drainAgain = false;
  /**
   * Routed submissions, ordered per binding: the lane's tail, and the
   * submission in flight per request id, which a retry of the same request
   * joins instead of queueing behind itself.
   */
  private readonly routingLanes = new Map<
    string,
    {
      tail: Promise<unknown>;
      requests: Map<
        string,
        { requestHash: string; response: Promise<ChannelTurnResponse> }
      >;
    }
  >();

  constructor(
    private readonly db: DoSqliteDatabase,
    private readonly host: ChannelTurnsHost,
  ) {}

  private get routing(): ChannelRoutingOptions | undefined {
    return this.host.routing;
  }

  private now(): number {
    return this.host.now?.() ?? Date.now();
  }

  private setup(): Promise<void> {
    this.setupPromise ??= (async () => {
      await this.db.run(`CREATE TABLE IF NOT EXISTS channel_requests (
        binding_id TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
        run_id TEXT NOT NULL UNIQUE, session_id TEXT,
        reply_mirrored INTEGER NOT NULL DEFAULT 0,
        user_mirrored INTEGER NOT NULL DEFAULT 1,
        mirror_pending INTEGER NOT NULL DEFAULT 0,
        mirror_failures INTEGER NOT NULL DEFAULT 0,
        mirror_retry_at INTEGER,
        created_at INTEGER,
        PRIMARY KEY (binding_id, request_id)
      )`);
      // Tables created before a column existed (CREATE TABLE IF NOT
      // EXISTS leaves them as they were).
      const columns = new Set(
        (
          await this.db.exec<{ name: string }>(
            'PRAGMA table_info(channel_requests)',
          )
        ).map((c) => c.name),
      );
      const add = async (name: string, definition: string) => {
        if (columns.has(name)) return false;
        await this.db.run(
          `ALTER TABLE channel_requests ADD COLUMN ${name} ${definition}`,
        );
        return true;
      };
      await add('reply_mirrored', 'INTEGER NOT NULL DEFAULT 0');
      // Before background mirroring, the user message was mirrored as the
      // request was admitted: older rows owe none (hence the default 1; a
      // run's admission sets 0 explicitly).
      await add('user_mirrored', 'INTEGER NOT NULL DEFAULT 1');
      if (await add('mirror_pending', 'INTEGER NOT NULL DEFAULT 0'))
        // A reply the old poll path still owed is owed to the mirror pass.
        await this.db.run(
          'UPDATE channel_requests SET mirror_pending = 1 WHERE reply_mirrored = 0 AND session_id IS NOT NULL',
        );
      await add('mirror_failures', 'INTEGER NOT NULL DEFAULT 0');
      await add('mirror_retry_at', 'INTEGER');
      await add('routing_json', 'TEXT');
      await add('routing_observation', 'TEXT');
      if (await add('created_at', 'INTEGER'))
        await this.db.run(
          'UPDATE channel_requests SET created_at = ? WHERE created_at IS NULL',
          [this.now()],
        );
      await this.db.run(
        'CREATE INDEX IF NOT EXISTS idx_channel_requests_mirror ON channel_requests(mirror_pending)',
      );
      await this.db.run(
        'CREATE INDEX IF NOT EXISTS idx_channel_requests_created ON channel_requests(created_at)',
      );
      await this.db.run(
        'CREATE INDEX IF NOT EXISTS idx_channel_requests_session ON channel_requests(binding_id, session_id)',
      );
      await this.db.run(`CREATE TABLE IF NOT EXISTS channel_controls (
        binding_id TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
        result TEXT, replacement_session_id TEXT, created_at INTEGER NOT NULL,
        PRIMARY KEY(binding_id, request_id)
      )`);
      if (
        !(
          await this.db.exec<{ name: string }>(
            'PRAGMA table_info(channel_controls)',
          )
        ).some((column) => column.name === 'replacement_session_id')
      )
        await this.db.run(
          'ALTER TABLE channel_controls ADD COLUMN replacement_session_id TEXT',
        );
      await this.db.run(`CREATE TABLE IF NOT EXISTS channel_cancellations (
        binding_id TEXT NOT NULL, request_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(binding_id, request_id)
      )`);
      await this.db.run(
        'CREATE INDEX IF NOT EXISTS idx_channel_controls_created ON channel_controls(created_at)',
      );
      await this.db.run(
        'CREATE INDEX IF NOT EXISTS idx_channel_cancellations_created ON channel_cancellations(created_at)',
      );
      // The sessions a binding has used, per consent revision: what `/resume`
      // may return to. Not seeded from older data: a session bound before
      // this table existed is recognised by its request receipts instead
      // (`usedByBinding`), which hold the same evidence.
      await this.db.run(`CREATE TABLE IF NOT EXISTS channel_session_bindings (
        binding_id TEXT NOT NULL, binding_revision INTEGER NOT NULL, session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(binding_id, binding_revision, session_id)
      )`);
      await this.db.run(`CREATE TABLE IF NOT EXISTS channel_sessions (
        binding_id TEXT PRIMARY KEY, session_id TEXT NOT NULL
      )`);
      const sessionColumns = await this.db.exec<{ name: string }>(
        'PRAGMA table_info(channel_sessions)',
      );
      for (const [name, definition] of [
        ['generation', 'INTEGER NOT NULL DEFAULT 0'],
        ['force_next', 'INTEGER NOT NULL DEFAULT 0'],
      ]) {
        if (!sessionColumns.some((column) => column.name === name))
          await this.db.run(
            `ALTER TABLE channel_sessions ADD COLUMN ${name} ${definition}`,
          );
      }
      if (this.routing?.mode !== undefined && this.routing.mode !== 'off') {
        await this.db.run(`CREATE TABLE IF NOT EXISTS channel_thread_index (
          binding_id TEXT NOT NULL, binding_revision INTEGER NOT NULL, session_id TEXT NOT NULL,
          topic TEXT NOT NULL, recent_user TEXT NOT NULL, recent_reply TEXT NOT NULL,
          last_run_id TEXT NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY(binding_id, binding_revision, session_id)
        )`);
        // How far `channel_requests` was read into the thread index, per
        // binding and revision: later turns read only the receipts after it.
        await this.db.run(`CREATE TABLE IF NOT EXISTS channel_thread_seeded (
          binding_id TEXT NOT NULL, binding_revision INTEGER NOT NULL,
          seeded_rowid INTEGER NOT NULL,
          PRIMARY KEY(binding_id, binding_revision)
        )`);
      }
    })().catch((error: unknown) => {
      this.setupPromise = undefined;
      throw error;
    });
    return this.setupPromise;
  }

  /** SQLite admission is serialized; stopping runs and Matrix I/O never hold that lock. */
  async control(
    identity: TurnIdentity,
    input: ChannelControlInput,
    requestHash: string,
  ): Promise<ChannelControlResult> {
    if (
      !identity.channel ||
      identity.channel.bindingId !== input.bindingId ||
      identity.channel.bindingRevision !== input.bindingRevision ||
      identity.channel.provider !== input.provider
    )
      throw new ChannelError(
        403,
        'Channel identity does not match this request',
        'identity_mismatch',
      );
    if (
      (input.command.kind === 'status' ||
        input.command.kind === 'topics' ||
        input.command.kind === 'rename') &&
      input.cancelRequestIds.length
    )
      throw new ChannelError(
        400,
        `A ${input.command.kind} request cannot cancel work`,
        'invalid_request',
      );
    const renamed =
      input.command.kind === 'rename'
        ? cleanTitle(input.command.title)
        : undefined;
    const saved = await this.serialize(async () => {
      await this.setup();
      const row = await this.db.get<{
        request_hash: string;
        result: string | null;
        replacement_session_id: string | null;
      }>(
        'SELECT request_hash,result,replacement_session_id FROM channel_controls WHERE binding_id=? AND request_id=?',
        [input.bindingId, input.requestId],
      );
      if (row && row.request_hash !== requestHash)
        throw new ChannelError(
          409,
          'Control request changed',
          'request_conflict',
        );
      const result = row?.result
        ? readStored(StoredChannelControlResult, row.result, 'control result')
        : undefined;
      if (result) return { result };
      await this.assertNotCancelled(input);
      if (!row) {
        await this.db.run(
          'INSERT INTO channel_controls(binding_id,request_id,request_hash,created_at) VALUES(?,?,?,?)',
          [input.bindingId, input.requestId, requestHash, this.now()],
        );
        await this.host.changed();
      }
      return { replacement: row?.replacement_session_id ?? undefined };
    });
    if (saved.result) return saved.result;
    // Refused destinations leave the existing binding and its work
    // untouched, and take their receipt with them: a corrected body under
    // the same id is the same control, not a conflict.
    try {
      if (input.command.kind === 'resume') {
        await this.host.assertSession(identity, input.command.sessionId);
        if (!(await this.usedByBinding(input, input.command.sessionId)))
          throw new ChannelError(
            404,
            'Oracle session not found',
            'session_not_found',
          );
      }
      if (input.command.kind === 'new')
        await this.host.requireDelegation(identity);
      if (input.command.kind === 'rename') {
        if (!(await this.boundSession(input.bindingId)))
          throw new ChannelError(
            404,
            'This conversation has no topic to rename',
            'session_not_found',
          );
      }
    } catch (error) {
      await this.serialize(async () => {
        const dropped = await this.db.run(
          'DELETE FROM channel_controls WHERE binding_id=? AND request_id=? AND result IS NULL',
          [input.bindingId, input.requestId],
        );
        if (dropped.changes > 0) await this.host.changed();
      });
      throw error;
    }
    await this.serialize(async () => {
      await this.assertNotCancelled(input);
      let reserved = 0;
      for (const requestId of input.cancelRequestIds)
        reserved += (
          await this.db.run(
            'INSERT OR IGNORE INTO channel_cancellations(binding_id,request_id,created_at) VALUES(?,?,?)',
            [input.bindingId, requestId, this.now()],
          )
        ).changes;
      if (reserved > 0) await this.host.changed();
    });
    // The reservations above are durable and checked before every attempt,
    // so nothing named can start any more. A run that is still winding down
    // (a tool call in flight) is not waited for past one shared grace: a
    // retry of this control could not stop it any sooner.
    if (input.cancelRequestIds.length)
      await this.host.stopRuns(
        await Promise.all(
          input.cancelRequestIds.map((requestId) =>
            channelRunId(input.bindingId, requestId),
          ),
        ),
      );
    let replacement: string | undefined;
    if (input.command.kind === 'new') {
      replacement = saved.replacement;
      if (!replacement) {
        replacement = await this.host.createSession(
          identity,
          `channel-reset-${await channelRequestHash(JSON.stringify([input.bindingId, input.requestId]))}`,
        );
        // A retry reuses the session instead of asking Matrix again.
        const created = replacement;
        await this.serialize(async () => {
          const stored = await this.db.run(
            'UPDATE channel_controls SET replacement_session_id=? WHERE binding_id=? AND request_id=? AND replacement_session_id IS NULL',
            [created, input.bindingId, input.requestId],
          );
          if (stored.changes > 0) await this.host.changed();
        });
      }
      await this.host.assertSession(identity, replacement);
    } else if (input.command.kind === 'resume')
      replacement = input.command.sessionId;
    const listing =
      input.command.kind === 'topics'
        ? await this.listTopics(input)
        : undefined;
    return this.serialize(async () => {
      // A later stop can cancel this control while its Matrix call is outstanding.
      await this.assertNotCancelled(input);
      const completed = await this.db.get<{ result: string | null }>(
        'SELECT result FROM channel_controls WHERE binding_id=? AND request_id=?',
        [input.bindingId, input.requestId],
      );
      const already = completed?.result
        ? readStored(
            StoredChannelControlResult,
            completed.result,
            'control result',
          )
        : undefined;
      if (already) return already;
      if (replacement) {
        await this.db.run(
          'INSERT INTO channel_sessions(binding_id,session_id,generation,force_next) VALUES(?,?,1,1) ON CONFLICT(binding_id) DO UPDATE SET session_id=excluded.session_id,generation=channel_sessions.generation+1,force_next=1',
          [input.bindingId, replacement],
        );
        await this.recordSessionBinding(input, replacement);
      }
      const sessionId = listing
        ? listing.bound
        : (replacement ?? (await this.boundSession(input.bindingId)));
      if (renamed !== undefined) {
        // Bound now, not as it was when the title was checked: a reset in
        // between moves the name to the topic the person is in.
        if (
          !sessionId ||
          !(await this.host.renameSession(sessionId, renamed))
        ) {
          // Refused after the checks passed: the receipt goes with it, so a
          // corrected retry under the same id is not a conflict.
          const dropped = await this.db.run(
            'DELETE FROM channel_controls WHERE binding_id=? AND request_id=? AND result IS NULL',
            [input.bindingId, input.requestId],
          );
          if (dropped.changes > 0) await this.host.changed();
          throw new ChannelError(
            404,
            'This conversation has no topic to rename',
            'session_not_found',
          );
        }
        await this.host.changed();
      }
      const result: ChannelControlResult = {
        requestId: input.requestId,
        sessionId,
        command: input.command.kind,
        title: await this.titleOf(sessionId),
        ...(listing ? { topics: listing.topics } : {}),
      };
      await this.db.run(
        'UPDATE channel_controls SET result=? WHERE binding_id=? AND request_id=?',
        [JSON.stringify(result), input.bindingId, input.requestId],
      );
      await this.host.changed();
      return result;
    });
  }

  /**
   * A session's title for use inside `*…*`: one plain line without the
   * characters that would end or restyle the markup, at most 80 code points;
   * null when untitled or unknown.
   */
  private async boldTitle(sessionId: string | null): Promise<string | null> {
    if (!sessionId) return null;
    const title = wireTitle(
      (await this.host.describeSessions([sessionId])).get(sessionId)?.title,
    );
    if (!title) return null;
    const plain = clipCodePoints(
      plainLine(title.replace(/[*_~`]/gu, '')),
      CHANNEL_TITLE_LIMIT,
    );
    return plain.length > 0 ? plain : null;
  }

  /** The title of a session as the wire carries it: null when untitled or unknown. */
  private async titleOf(sessionId: string | null): Promise<string | null> {
    if (!sessionId) return null;
    const found = await this.host.describeSessions([sessionId]);
    return wireTitle(found.get(sessionId)?.title);
  }

  /**
   * The sessions this binding used at its current consent revision (the
   * bound one among them), most recent activity first, and the bound session
   * the list was built from. Read-only apart from forgetting the binding
   * rows of sessions the user deleted.
   */
  private async listTopics(
    input: Pick<ChannelTurnInput, 'bindingId' | 'bindingRevision'>,
  ): Promise<{ bound: string | null; topics: ChannelTopic[] }> {
    const used = await this.db.exec<{ session_id: string }>(
      'SELECT session_id FROM channel_session_bindings WHERE binding_id=? AND binding_revision=? ORDER BY created_at DESC, rowid DESC LIMIT ?',
      [input.bindingId, input.bindingRevision, CHANNEL_TOPICS_SCAN],
    );
    const bound = await this.boundSession(input.bindingId);
    const ids = new Set(used.map((row) => row.session_id));
    if (bound) ids.add(bound);
    const described = await this.host.describeSessions([...ids]);
    const deleted = [...ids].filter((sessionId) => !described.has(sessionId));
    if (deleted.length)
      await this.serialize(async () => {
        let removed = 0;
        for (let at = 0; at < deleted.length; at += CHANNEL_IDS_PER_STATEMENT) {
          const chunk = deleted.slice(at, at + CHANNEL_IDS_PER_STATEMENT);
          removed += (
            await this.db.run(
              `DELETE FROM channel_session_bindings WHERE binding_id=? AND session_id IN (${chunk.map(() => '?').join(', ')})`,
              [input.bindingId, ...chunk],
            )
          ).changes;
        }
        if (removed > 0) await this.host.changed();
      });
    const byActivity = [...described]
      .map(([sessionId, info]) => ({ sessionId, info }))
      .sort((a, b) => b.info.updatedAt - a.info.updatedAt);
    let kept = byActivity.slice(0, CHANNEL_TOPICS_LIMIT);
    const boundEntry = byActivity.find((entry) => entry.sessionId === bound);
    if (boundEntry && !kept.includes(boundEntry))
      kept = [...kept.slice(0, CHANNEL_TOPICS_LIMIT - 1), boundEntry].sort(
        (a, b) => b.info.updatedAt - a.info.updatedAt,
      );
    const newest = await this.newestReceipts(
      input.bindingId,
      kept.map((entry) => entry.sessionId),
    );
    const topics: ChannelTopic[] = [];
    for (const { sessionId, info } of kept) {
      const line = await this.topicLines(
        input,
        sessionId,
        newest.get(sessionId),
      );
      topics.push({
        sessionId,
        title: wireTitle(info.title),
        createdAt: info.createdAt,
        updatedAt: info.updatedAt,
        ...line,
      });
    }
    return { bound, topics };
  }

  /** The run of the newest request receipt of each session, in one statement. */
  private async newestReceipts(
    bindingId: string,
    sessionIds: readonly string[],
  ): Promise<Map<string, string>> {
    const newest = new Map<string, string>();
    if (sessionIds.length === 0) return newest;
    const marks = sessionIds.map(() => '?').join(', ');
    const rows = await this.db.exec<{ session_id: string; run_id: string }>(
      `SELECT session_id, run_id FROM channel_requests WHERE binding_id=? AND rowid IN (SELECT MAX(rowid) FROM channel_requests WHERE binding_id=? AND session_id IN (${marks}) GROUP BY session_id)`,
      [bindingId, bindingId, ...sessionIds],
    );
    for (const row of rows) newest.set(row.session_id, row.run_id);
    return newest;
  }

  /**
   * What the person last said in a session and the reply to it, from the
   * newest receipt that is not a routing question (those are the oracle's
   * words, not the topic's). Null lines when there is none, when it was sent
   * under another consent revision, or when its stored request is unreadable.
   */
  private async topicLines(
    input: Pick<ChannelTurnInput, 'bindingId' | 'bindingRevision'>,
    sessionId: string,
    newestRunId: string | undefined,
  ): Promise<{ lastUser: string | null; lastReply: string | null }> {
    const none = { lastUser: null, lastReply: null };
    if (!newestRunId) return none;
    let found = await this.topicReceipt(newestRunId);
    if (found?.request.channel?.routingClarification) {
      found = undefined;
      const recent = await this.db.exec<{ run_id: string }>(
        'SELECT run_id FROM channel_requests WHERE binding_id=? AND session_id=? ORDER BY rowid DESC LIMIT ?',
        [input.bindingId, sessionId, CHANNEL_TOPIC_LOOKBACK],
      );
      for (const row of recent) {
        const candidate = await this.topicReceipt(row.run_id);
        if (candidate && !candidate.request.channel?.routingClarification) {
          found = candidate;
          break;
        }
      }
    }
    // Text from before the person's latest consent is not quoted.
    if (
      !found ||
      found.request.identity.channel?.bindingRevision !== input.bindingRevision
    )
      return none;
    return {
      lastUser: topicLine(found.request.message),
      lastReply: topicLine(
        found.run.status === 'finished' ? found.run.partialText : null,
      ),
    };
  }

  /** A run and its stored request; undefined when either is missing or unreadable. */
  private async topicReceipt(
    runId: string,
  ): Promise<{ run: RunRecord; request: TurnRequest } | undefined> {
    const run = await this.host.getRun(runId);
    if (!run) return undefined;
    try {
      return { run, request: this.host.requestOf(run) };
    } catch {
      return undefined;
    }
  }

  /**
   * Note that the binding, at its current consent revision, uses `sessionId`,
   * and when it last did: `created_at` is the time of the latest binding, so
   * `topics` reads the most recently bound sessions.
   */
  private async recordSessionBinding(
    input: Pick<ChannelTurnInput, 'bindingId' | 'bindingRevision'>,
    sessionId: string,
  ): Promise<void> {
    const recorded = await this.db.run(
      'INSERT INTO channel_session_bindings(binding_id,binding_revision,session_id,created_at) VALUES(?,?,?,?) ON CONFLICT(binding_id,binding_revision,session_id) DO UPDATE SET created_at=excluded.created_at WHERE excluded.created_at > channel_session_bindings.created_at',
      [input.bindingId, input.bindingRevision, sessionId, this.now()],
    );
    if (recorded.changes > 0) await this.host.changed();
  }

  /**
   * Whether this binding used `sessionId` at its current consent revision:
   * the only sessions `/resume` may return to. A Portal conversation, or
   * one this binding used under an earlier consent, is not one of them.
   */
  private async usedByBinding(
    input: Pick<ChannelTurnInput, 'bindingId' | 'bindingRevision'>,
    sessionId: string,
  ): Promise<boolean> {
    if (
      await this.db.get(
        'SELECT 1 FROM channel_session_bindings WHERE binding_id=? AND binding_revision=? AND session_id=?',
        [input.bindingId, input.bindingRevision, sessionId],
      )
    )
      return true;
    // A session bound before `channel_session_bindings` existed: the stored
    // request of the binding's latest receipt in it carries the revision.
    // Revisions only grow, so no older receipt can match when it does not.
    const latest = await this.db.get<{ run_id: string }>(
      'SELECT run_id FROM channel_requests WHERE binding_id=? AND session_id=? ORDER BY rowid DESC LIMIT 1',
      [input.bindingId, sessionId],
    );
    const run = latest ? await this.host.getRun(latest.run_id) : undefined;
    return (
      run !== undefined &&
      this.host.requestOf(run).identity.channel?.bindingRevision ===
        input.bindingRevision
    );
  }

  async isCancelled(
    input: Pick<ChannelTurnInput, 'bindingId' | 'requestId'>,
  ): Promise<boolean> {
    await this.setup();
    return Boolean(
      await this.db.get(
        'SELECT 1 FROM channel_cancellations WHERE binding_id=? AND request_id=?',
        [input.bindingId, input.requestId],
      ),
    );
  }

  private async assertNotCancelled(
    input: Pick<ChannelTurnInput, 'bindingId' | 'requestId'>,
  ): Promise<void> {
    if (await this.isCancelled(input))
      throw new ChannelError(
        409,
        'This message was cancelled by its owner',
        'request_cancelled',
      );
  }

  private async replyContext(
    input: ChannelTurnInput,
    sessionId: string,
  ): Promise<ChannelReplyContext | undefined> {
    const reference = input.replyTo;
    if (!reference) return undefined;
    const unknown: ChannelReplyContext = {
      kind: 'unavailable',
      reason: 'unknown',
    };
    if (reference.kind === 'unavailable') return unknown;
    const receipt = await this.receipt({
      ...input,
      requestId: reference.requestId,
    });
    if (!receipt?.session_id) return unknown;
    // The quote is this binding's, but its conversation is not the one the
    // turn runs in (a routed quote whose session could not be selected
    // lands here too): its text stays out of this conversation.
    if (receipt.session_id !== sessionId)
      return { kind: 'unavailable', reason: 'other_conversation' };
    const run = await this.host.getRun(receipt.run_id);
    if (!run) return unknown;
    let text: string;
    if (reference.author === 'user') text = this.host.requestOf(run).message;
    else {
      if (run.status !== 'finished') return unknown;
      const reply = await this.reply(run.runId, run.partialText ?? '');
      const chunk = reference.partId
        ? /^(.*)\.([1-9]\d*)$/.exec(reference.partId)
        : null;
      const matched =
        reference.partId && reply.plan
          ? (reply.plan.parts.find((p) => p.partId === reference.partId) ??
            (chunk?.[1]
              ? reply.plan.parts.find((p) => p.partId === chunk[1])
              : undefined))
          : undefined;
      if (reference.partId && reply.plan && !matched) return unknown;
      text = matched ? planText({ parts: [matched] }) : reply.rendered;
    }
    return {
      kind: 'resolved',
      requestId: reference.requestId,
      author: reference.author,
      text: text.slice(0, 16000),
    };
  }

  /**
   * The SQLite steps of admissions and session releases run one at a time.
   * Nothing that waits on Matrix runs under it.
   */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.admission.then(work);
    this.admission = next.catch(() => undefined);
    return next;
  }

  submit(
    identity: TurnIdentity,
    input: ChannelTurnInput,
    requestHash: string,
  ): Promise<ChannelTurnResponse> {
    if (!this.routingEnabled(input))
      return this.submitTurn(identity, input, requestHash);
    // Classifier/Matrix I/O is ordered per binding, outside the admission
    // lock. Controls and other bindings can still make progress.
    let lane = this.routingLanes.get(input.bindingId);
    if (!lane) {
      lane = { tail: Promise.resolve(), requests: new Map() };
      this.routingLanes.set(input.bindingId, lane);
    }
    // The gateway retries a request it timed out on: the retry answers with
    // the submission still in flight instead of queueing behind it.
    const inFlight = lane.requests.get(input.requestId);
    if (inFlight?.requestHash === requestHash) return inFlight.response;
    const owner = lane;
    const next = owner.tail
      .catch(() => undefined)
      .then(() =>
        withDeadline(
          this.submitTurn(identity, input, requestHash),
          ROUTING_LANE_DEADLINE_MS,
        ),
      );
    owner.tail = next;
    if (!inFlight)
      owner.requests.set(input.requestId, { requestHash, response: next });
    void next
      .finally(() => {
        if (owner.requests.get(input.requestId)?.response === next)
          owner.requests.delete(input.requestId);
        if (
          owner.tail === next &&
          this.routingLanes.get(input.bindingId) === owner
        )
          this.routingLanes.delete(input.bindingId);
      })
      .catch(() => undefined);
    return next;
  }

  private async submitTurn(
    identity: TurnIdentity,
    input: ChannelTurnInput,
    requestHash: string,
  ): Promise<ChannelTurnResponse> {
    if (
      !identity.channel ||
      identity.channel.bindingId !== input.bindingId ||
      identity.channel.bindingRevision !== input.bindingRevision ||
      identity.channel.provider !== input.provider
    )
      throw new ChannelError(
        403,
        'Channel identity does not match this request',
        'identity_mismatch',
      );
    const runId = await channelRunId(input.bindingId, input.requestId);
    // At most three passes: a binding whose session was deleted opens a new
    // one when the request named none, and a request refused while a
    // concurrent copy of it started its run answers that run.
    for (let pass = 0; ; pass += 1) {
      const received = await this.serialize(() =>
        this.receive(input, requestHash, runId),
      );
      if (received.kind === 'run') return received.response;
      let prepared: PreparedChannelTurn;
      try {
        prepared = await this.prepare(
          identity,
          input,
          received.sessionId,
          received.routingJson,
        );
      } catch (error) {
        const stale =
          error instanceof StaleSessionError && received.sessionId !== null;
        const raced = await this.serialize(() =>
          stale
            ? this.release(input, runId, received.sessionId ?? '')
            : this.refuse(runId),
        );
        if (pass < 2 && (raced || (stale && !input.sessionId))) continue;
        if (stale)
          throw new ChannelError(
            409,
            'The oracle session of this channel no longer exists; send the request again without sessionId',
            'session_conflict',
          );
        throw error;
      }
      return this.serialize(() =>
        this.start(identity, input, requestHash, runId, prepared),
      );
    }
  }

  /**
   * Answer a poll of a request whose run exists, from SQLite alone and
   * without the admission lock: null when the request has no run yet (or
   * its body differs), so the caller admits it the full way.
   */
  async poll(
    identity: TurnIdentity,
    input: ChannelTurnInput,
    requestHash: string,
  ): Promise<ChannelTurnResponse | null> {
    if (
      identity.channel?.bindingId !== input.bindingId ||
      identity.channel.bindingRevision !== input.bindingRevision ||
      identity.channel.provider !== input.provider
    )
      return null;
    await this.setup();
    const receipt = await this.receipt(input);
    if (!receipt?.session_id || receipt.request_hash !== requestHash)
      return null;
    const record = await this.host.getRun(receipt.run_id);
    if (!record) return null;
    return this.respond(input, receipt, receipt.session_id, record);
  }

  /**
   * A run ended: mirror what it still owes the user's oracle room (its reply)
   * in the background. The receipt records each mirror, so nothing is sent
   * twice; a failed one is retried by the housekeeping alarm.
   */
  deliverReply(): void {
    this.kick();
  }

  /** Resolves once no mirror pass is running (tests, and a draining object). */
  async whenIdle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  /** A finished run's Reply Plan, and the reply as the channel user sees it. */
  private async reply(
    runId: string,
    text: string,
  ): Promise<{ plan: ReplyPlan | null; rendered: string }> {
    const plan = parseReplyPlan(await this.host.getPlan(runId));
    const row = await this.db.get<{ routing_json: string | null }>(
      'SELECT routing_json FROM channel_requests WHERE run_id=?',
      [runId],
    );
    const route = row?.routing_json
      ? readStored(routeAssignmentSchema, row.routing_json, 'route assignment')
      : undefined;
    let notice: string | undefined;
    if (route?.mode === 'on' && route.destination.kind === 'new') {
      const before = await this.boldTitle(route.baseline);
      notice = `Starting a fresh topic for this. Send /resume to go back to ${before ? `*${before}*` : 'the previous topic'}.`;
    } else if (
      route?.mode === 'on' &&
      route.destination.kind === 'session' &&
      route.destination.sessionId !== route.baseline
    ) {
      const to = await this.boldTitle(route.destination.sessionId);
      notice = `Back to ${to ? `*${to}*` : 'an earlier topic'}. Send /resume to go back.`;
    }
    if (!notice) return { plan, rendered: plan ? planText(plan) : text };
    const decorated =
      plan && plan.parts.length < 999
        ? {
            ...plan,
            parts: [
              {
                partId: 'channel_thread_notice',
                kind: 'text' as const,
                text: notice,
              },
              ...plan.parts,
            ],
          }
        : null;
    return {
      plan: decorated,
      rendered: decorated
        ? planText(decorated)
        : `${notice}\n\n${plan ? planText(plan) : text}`,
    };
  }

  /**
   * The session was deleted: release every binding that pointed at it, so
   * the binding's next message opens a new oracle session. Returns
   * whether a binding was released.
   */
  forgetSession(sessionId: string): Promise<boolean> {
    return this.serialize(async () => {
      await this.setup();
      // A first message still opening a session must not hand the deleted
      // one to the binding's next message.
      this.opening.clear();
      if (
        await this.db.get(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='channel_thread_index'",
        )
      ) {
        const removed = await this.db.run(
          'DELETE FROM channel_thread_index WHERE session_id=?',
          [sessionId],
        );
        if (removed.changes) await this.host.changed();
      }
      const unbound = await this.db.run(
        'DELETE FROM channel_session_bindings WHERE session_id=?',
        [sessionId],
      );
      if (unbound.changes) await this.host.changed();
      const released = await this.db.run(
        'DELETE FROM channel_sessions WHERE session_id = ?',
        [sessionId],
      );
      if (released.changes === 0) return false;
      await this.host.changed();
      return true;
    });
  }

  /**
   * Housekeeping (the object's alarm): remove, in bounded batches, receipts
   * whose request never started a run and tombstones of pruned runs, both
   * once older than `CHANNEL_RECORD_RETENTION_MS`; and start a mirror pass
   * when an owed mirror is due. Returns when to come back (epoch ms), or
   * null when nothing is left to do.
   */
  async housekeeping(): Promise<number | null> {
    // A user who never used a channel has no channel tables: none are
    // created for them here.
    if (
      !this.setupPromise &&
      !(await this.db.get(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'channel_requests'`,
      ))
    )
      return null;
    await this.setup();
    const now = this.now();
    const before = now - CHANNEL_RECORD_RETENTION_MS;
    // `turn_runs` belongs to the run store, in the same database.
    const receipts = await this.db.run(
      `DELETE FROM channel_requests WHERE rowid IN (
         SELECT r.rowid FROM channel_requests r
         WHERE r.created_at < ?
           AND NOT EXISTS (SELECT 1 FROM turn_runs t WHERE t.run_id = r.run_id)
         LIMIT ?
       )`,
      [before, CHANNEL_PRUNE_BATCH],
    );
    let controlsPruned = 0;
    for (const table of ['channel_controls', 'channel_cancellations']) {
      const pruned = await this.db.run(
        `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE created_at<? LIMIT ?)`,
        [before, CHANNEL_PRUNE_BATCH],
      );
      controlsPruned += pruned.changes;
    }
    if (controlsPruned) await this.host.changed();
    const tombstones = await this.host.pruneTombstones(
      before,
      CHANNEL_PRUNE_BATCH,
    );
    if (receipts.changes > 0 || tombstones > 0) {
      console.log(
        `[channels] pruned ${receipts.changes} receipt(s) that never started a run and ${tombstones} run tombstone(s)`,
      );
      await this.host.changed();
    }
    const owed = await this.db.get<{ at: number | null }>(
      'SELECT MIN(COALESCE(mirror_retry_at, 0)) AS at FROM channel_requests WHERE mirror_pending = 1',
    );
    const owedAt = typeof owed?.at === 'number' ? owed.at : null;
    if (owedAt !== null && owedAt <= now) this.kick();
    if (
      controlsPruned >= CHANNEL_PRUNE_BATCH ||
      receipts.changes >= CHANNEL_PRUNE_BATCH ||
      tombstones >= CHANNEL_PRUNE_BATCH
    )
      return now + 60_000;
    return owedAt !== null && owedAt > now ? owedAt : null;
  }

  private receipt(
    input: Pick<ChannelTurnInput, 'bindingId' | 'requestId'>,
  ): Promise<ReceiptRow | undefined> {
    return this.db.get<ReceiptRow>(
      'SELECT * FROM channel_requests WHERE binding_id = ? AND request_id = ?',
      [input.bindingId, input.requestId],
    );
  }

  private async boundSession(bindingId: string): Promise<string | null> {
    const binding = await this.db.get<{ session_id: string }>(
      'SELECT session_id FROM channel_sessions WHERE binding_id = ?',
      [bindingId],
    );
    return binding?.session_id ?? null;
  }

  private routingEnabled(input: ChannelTurnInput): boolean {
    return Boolean(
      this.routing &&
      this.routing.mode !== 'off' &&
      (!this.routing.bindings.length ||
        this.routing.bindings.includes(input.bindingId)),
    );
  }

  private async routingState(
    bindingId: string,
  ): Promise<{ generation: number; force_next: number }> {
    return (
      (await this.db.get<{ generation: number; force_next: number }>(
        'SELECT generation,force_next FROM channel_sessions WHERE binding_id=?',
        [bindingId],
      )) ?? { generation: 0, force_next: 0 }
    );
  }

  private async indexThread(
    input: ChannelTurnInput,
    sessionId: string,
    runId: string,
    at = this.now(),
  ): Promise<void> {
    await this.db.run(
      `INSERT INTO channel_thread_index
      (binding_id,binding_revision,session_id,topic,recent_user,recent_reply,last_run_id,updated_at)
      VALUES(?,?,?,?,?,'',?,?) ON CONFLICT(binding_id,binding_revision,session_id)
      DO UPDATE SET recent_user=excluded.recent_user,last_run_id=excluded.last_run_id,updated_at=excluded.updated_at`,
      [
        input.bindingId,
        input.bindingRevision,
        sessionId,
        input.message.slice(0, 300),
        input.message.slice(0, 800),
        runId,
        at,
      ],
    );
    await this.db.run(
      `DELETE FROM channel_thread_index WHERE binding_id=? AND rowid NOT IN
      (SELECT rowid FROM channel_thread_index WHERE binding_id=? ORDER BY updated_at DESC,rowid DESC LIMIT ?)`,
      [input.bindingId, input.bindingId, CHANNEL_THREAD_LIMIT],
    );
    await this.host.changed();
  }

  private async routingCandidates(
    input: ChannelTurnInput,
    baseline: string,
  ): Promise<ChannelThreadCandidate[]> {
    const routing = this.routing;
    if (!routing) return [];
    // Index the receipts written since the binding's last read: all of them
    // when an operator first enables routing, then the ones written while
    // routing was off (routed turns index themselves as they start). The
    // canonical stored request supplies revision isolation for older receipts.
    const seeded = await this.db.get<{ seeded_rowid: number }>(
      'SELECT seeded_rowid FROM channel_thread_seeded WHERE binding_id=? AND binding_revision=?',
      [input.bindingId, input.bindingRevision],
    );
    const after = Number(seeded?.seeded_rowid ?? 0);
    const newest = await this.db.get<{ last: number | null }>(
      'SELECT MAX(rowid) AS last FROM channel_requests WHERE binding_id=?',
      [input.bindingId],
    );
    const upTo = Number(newest?.last ?? 0);
    const prior =
      upTo > after
        ? await this.db.exec<{ session_id: string; run_id: string }>(
            `SELECT session_id,run_id,MAX(rowid) AS last_row FROM channel_requests
            WHERE binding_id=? AND rowid>? AND session_id IS NOT NULL GROUP BY session_id
            ORDER BY last_row DESC LIMIT ?`,
            [input.bindingId, after, CHANNEL_THREAD_LIMIT],
          )
        : [];
    for (const row of prior.reverse()) {
      const indexed = await this.db.get<{ last_run_id: string }>(
        'SELECT last_run_id FROM channel_thread_index WHERE binding_id=? AND binding_revision=? AND session_id=?',
        [input.bindingId, input.bindingRevision, row.session_id],
      );
      if (indexed?.last_run_id === row.run_id) continue;
      const run = await this.host.getRun(row.run_id);
      if (!run) continue;
      const request = this.host.requestOf(run);
      if (request.channel?.routingClarification) continue;
      if (
        request.identity.channel?.bindingRevision !== input.bindingRevision ||
        request.channel?.bindingId !== input.bindingId
      )
        continue;
      await this.indexThread(
        { ...input, message: request.message },
        row.session_id,
        row.run_id,
        Date.parse(run.updatedAt),
      );
    }
    if (upTo > after) {
      await this.db.run(
        `INSERT INTO channel_thread_seeded(binding_id,binding_revision,seeded_rowid) VALUES(?,?,?)
        ON CONFLICT(binding_id,binding_revision) DO UPDATE SET seeded_rowid=excluded.seeded_rowid`,
        [input.bindingId, input.bindingRevision, upTo],
      );
      await this.host.changed();
    }
    const indexed = await this.db.exec<{
      session_id: string;
      topic: string;
      recent_user: string;
      recent_reply: string;
      last_run_id: string;
    }>(
      'SELECT * FROM channel_thread_index WHERE binding_id=? AND binding_revision=? ORDER BY updated_at DESC,rowid DESC LIMIT ?',
      [input.bindingId, input.bindingRevision, CHANNEL_THREAD_LIMIT],
    );
    const candidates: ChannelThreadCandidate[] = [];
    for (const row of indexed) {
      if (!(await routing.ownsSession(row.session_id))) continue;
      const run = await this.host.getRun(row.last_run_id);
      candidates.push({
        sessionId: row.session_id,
        topic: row.topic,
        recentUser: row.recent_user,
        recentReply:
          run?.status === 'finished'
            ? (run.partialText ?? '').slice(0, 800)
            : row.recent_reply,
        status: run?.status ?? 'history',
      });
    }
    return selectChannelCandidates(candidates, input.message, baseline);
  }

  /**
   * The request's route: the one stored on its receipt, else (routing on
   * for the binding) a new one, stored before anything runs. `storedJson`
   * is the receipt's assignment as admission read it, so a turn the router
   * does not handle (the default) reads nothing more, while an assigned
   * request keeps its destination across a flag change.
   */
  private async assignRoute(
    input: ChannelTurnInput,
    baseline: string,
    storedJson: string | null,
  ): Promise<ChannelRouteAssignment | undefined> {
    const routing = this.routing;
    if (!this.routingEnabled(input) || !routing || routing.mode === 'off')
      return storedJson
        ? readStored(routeAssignmentSchema, storedJson, 'route assignment')
        : undefined;
    // Routed turns of a binding run one at a time (`submit`), so the
    // receipt read here is current.
    const receipt = await this.receipt(input);
    if (receipt?.routing_json)
      return readStored(
        routeAssignmentSchema,
        receipt.routing_json,
        'route assignment',
      );
    const mode = routing.mode;
    const state = await this.routingState(input.bindingId);
    const assignment: ChannelRouteAssignment = {
      mode,
      baseline,
      generation: state.generation,
      destination: { kind: 'session', sessionId: baseline },
      reason: 'first-turn',
    };
    const recordObservation = async (observation: ChannelRouteObservation) => {
      const scoped = { ...observation, mode };
      await this.db.run(
        'UPDATE channel_requests SET routing_observation=? WHERE binding_id=? AND request_id=?',
        [JSON.stringify(scoped), input.bindingId, input.requestId],
      );
      await this.host.changed();
      routing.observe({ ...scoped, requestId: input.requestId });
    };
    let evaluate: (() => Promise<ChannelRouteObservation>) | undefined;
    if (state.force_next || input.sessionPolicy === 'continue')
      assignment.reason = 'explicit-control';
    else if (input.replyTo) {
      assignment.reason = 'quoted-message';
      const referenced =
        input.replyTo.kind === 'known'
          ? await this.receipt({ ...input, requestId: input.replyTo.requestId })
          : undefined;
      const run = referenced
        ? await this.host.getRun(referenced.run_id)
        : undefined;
      const request = run ? this.host.requestOf(run) : undefined;
      const session = referenced?.session_id;
      if (
        session &&
        request?.identity.channel?.bindingRevision === input.bindingRevision &&
        (await routing.ownsSession(session)) &&
        (await this.replyContext(input, session))?.kind === 'resolved'
      ) {
        if (mode === 'on')
          assignment.destination = { kind: 'session', sessionId: session };
      } else if (mode === 'on')
        assignment.destination = { kind: 'clarify', text: ambiguousThreadText };
    } else {
      const candidates = await this.routingCandidates(input, baseline);
      if (candidates.length) {
        const evidence = {
          message: input.message,
          currentSessionId: baseline,
          candidates,
        };
        const evidenceHash = await channelRequestHash(
          JSON.stringify(channelSessionDecision.prepare(evidence)),
        );
        const evaluateCandidates =
          async (): Promise<ChannelRouteObservation> => {
            const started = this.now();
            try {
              const evaluation = await routing.evaluator.evaluate(
                channelSessionDecision,
                evidence,
              );
              return {
                ...decideChannelRoute(
                  evaluation,
                  candidates,
                  routing.minProbability,
                ),
                evidenceHash,
                latencyMs: this.now() - started,
              };
            } catch {
              // A classifier outage (error, timeout, unusable answer) must
              // not hold the user's message: it stays in the current
              // conversation, as with routing off.
              return {
                mode,
                reason: 'provider-unavailable',
                evidenceHash,
                latencyMs: this.now() - started,
                destination: { kind: 'session', sessionId: baseline },
              };
            }
          };
        evaluate = evaluateCandidates;
        if (mode === 'on') {
          const observation = await evaluateCandidates();
          assignment.reason = observation.reason;
          assignment.destination = observation.destination ?? {
            kind: 'clarify',
            text: ambiguousThreadText,
          };
          await recordObservation(observation);
        } else assignment.reason = 'shadow';
      }
    }
    await this.serialize(async () => {
      await this.assertNotCancelled(input);
      await this.db.run(
        'UPDATE channel_requests SET routing_json=? WHERE binding_id=? AND request_id=? AND routing_json IS NULL',
        [JSON.stringify(assignment), input.bindingId, input.requestId],
      );
      await this.host.changed();
    });
    if (mode === 'shadow' && evaluate)
      this.host.keepAlive(
        evaluate()
          .then(recordObservation)
          .catch(() => undefined),
      );
    return assignment;
  }

  /** Step 1 (under the lock): the receipt, and the run if there is one. */
  private async receive(
    input: ChannelTurnInput,
    requestHash: string,
    runId: string,
  ): Promise<Received> {
    await this.setup();
    // A request that has its run is answered from it, also once a stop
    // named it: a stop that arrived after the run finished must not hide
    // the reply the user is owed.
    const existing = await this.receipt(input);
    if (existing?.session_id && existing.request_hash === requestHash) {
      const record = await this.host.getRun(runId);
      if (record)
        return {
          kind: 'run',
          response: await this.respond(
            input,
            existing,
            existing.session_id,
            record,
          ),
        };
    }
    await this.assertNotCancelled(input);
    // Checked before a receipt is written: the receipt of a pruned run is
    // gone (run-store.ts), and a new one must not take its place.
    if (await this.host.wasPruned(runId))
      throw new ChannelError(
        410,
        'Channel response has expired; this request cannot execute again',
        'response_expired',
      );
    const admitted = await this.db.run(
      `INSERT OR IGNORE INTO channel_requests
      (binding_id, request_id, request_hash, run_id, created_at) VALUES (?, ?, ?, ?, ?)`,
      [input.bindingId, input.requestId, requestHash, runId, this.now()],
    );
    // A poll of an admitted request changes nothing.
    if (admitted.changes === 1) await this.host.changed();
    const receipt = await this.receipt(input);
    if (!receipt || receipt.request_hash !== requestHash)
      throw new ChannelError(
        409,
        'This request ID already belongs to another message',
        'request_conflict',
      );
    if (receipt.session_id) {
      // A poll of a run that exists already only reads its receipt and row.
      const record = await this.host.getRun(runId);
      if (record)
        return {
          kind: 'run',
          response: await this.respond(
            input,
            receipt,
            receipt.session_id,
            record,
          ),
        };
      return {
        kind: 'new',
        sessionId: receipt.session_id,
        routingJson: receipt.routing_json,
      };
    }
    const bound = await this.boundSession(input.bindingId);
    if (
      bound &&
      input.sessionId &&
      bound !== input.sessionId &&
      !receipt.routing_json &&
      !(this.routingEnabled(input) && this.routing?.mode === 'on')
    ) {
      await this.dropReceipt(runId);
      throw new ChannelError(
        409,
        'This channel already has another session',
        'session_conflict',
      );
    }
    return {
      kind: 'new',
      sessionId: bound ?? input.sessionId ?? null,
      routingJson: receipt.routing_json,
    };
  }

  /**
   * Step 2 (outside the lock): the checks a new run needs, which may wait
   * on Matrix. The delegation first: a request that cannot run never sends
   * a session marker. Returns the session the request runs in.
   */
  private async prepare(
    identity: TurnIdentity,
    input: ChannelTurnInput,
    sessionId: string | null,
    storedRouting: string | null,
  ): Promise<PreparedChannelTurn> {
    await this.host.requireDelegation(identity);
    const session =
      sessionId ??
      (await this.boundSession(input.bindingId)) ??
      (await this.openSession(identity, input));
    await this.host.assertSession(identity, session);
    const routing = await this.assignRoute(input, session, storedRouting);
    if (!routing) return { sessionId: session };
    const destination = routing.destination;
    const selected =
      destination.kind === 'new'
        ? ((await this.receipt(input))?.session_id ??
          (await this.host.createSession(
            identity,
            `channel-route-new-${await channelRequestHash(JSON.stringify([input.bindingId, input.requestId]))}`,
          )))
        : destination.kind === 'session'
          ? destination.sessionId
          : routing.baseline;
    try {
      await this.host.assertSession(identity, selected);
    } catch (error) {
      if (error instanceof StaleSessionError)
        throw new ChannelError(
          404,
          'The selected conversation no longer exists; send a new message',
          'session_not_found',
        );
      throw error;
    }
    return { sessionId: selected, routing };
  }

  /**
   * The session for a binding's first message. The marker transaction id
   * is fixed per binding AND the request that opens the session: a retry
   * of that request reuses the marker event, while a binding whose session
   * was deleted gets a new one. Concurrent first messages share one open.
   */
  private openSession(
    identity: TurnIdentity,
    input: ChannelTurnInput,
  ): Promise<string> {
    const pending = this.opening.get(input.bindingId);
    if (pending) return pending;
    const opening = (async () =>
      this.host.createSession(
        identity,
        `channel-session-${await channelRequestHash(JSON.stringify([input.bindingId, input.requestId]))}`,
      ))();
    this.opening.set(input.bindingId, opening);
    opening.catch(() => {
      if (this.opening.get(input.bindingId) === opening)
        this.opening.delete(input.bindingId);
    });
    return opening;
  }

  /**
   * A request refused before it started a run leaves no receipt behind:
   * the same request id can be sent again, also with another body (without
   * `sessionId`, say). Returns true when a concurrent copy of the request
   * started its run meanwhile (the receipt then stays).
   */
  private async refuse(runId: string): Promise<boolean> {
    await this.setup();
    if (await this.host.getRun(runId)) return true;
    await this.dropReceipt(runId, true);
    return false;
  }

  private async dropReceipt(
    runId: string,
    preserveRouting = false,
  ): Promise<void> {
    const dropped = await this.db.run(
      `DELETE FROM channel_requests WHERE run_id = ?${preserveRouting ? ' AND routing_json IS NULL' : ''}`,
      [runId],
    );
    if (dropped.changes > 0) await this.host.changed();
  }

  /**
   * The session a new request was to run in is gone: the binding forgets
   * it. A request that named the session loses its receipt (it is sent
   * again without `sessionId`, a different body); one that did not keeps
   * it, unbound, and opens a new session on the next pass.
   */
  private async release(
    input: ChannelTurnInput,
    runId: string,
    sessionId: string,
  ): Promise<boolean> {
    await this.setup();
    if (await this.host.getRun(runId)) return true;
    this.opening.delete(input.bindingId);
    await this.db.run(
      'DELETE FROM channel_sessions WHERE binding_id = ? AND session_id = ?',
      [input.bindingId, sessionId],
    );
    if (input.sessionId)
      await this.db.run('DELETE FROM channel_requests WHERE run_id = ?', [
        runId,
      ]);
    else
      await this.db.run(
        'UPDATE channel_requests SET session_id = NULL WHERE run_id = ?',
        [runId],
      );
    await this.host.changed();
    console.warn(
      `[channels] binding ${input.bindingId} released its session ${sessionId}: it no longer exists`,
    );
    return false;
  }

  /** Step 3 (under the lock): bind the session and begin the run. */
  private async start(
    identity: TurnIdentity,
    input: ChannelTurnInput,
    requestHash: string,
    runId: string,
    prepared: PreparedChannelTurn,
  ): Promise<ChannelTurnResponse> {
    const { sessionId } = prepared;
    let routing = prepared.routing;
    await this.setup();
    await this.assertNotCancelled(input);
    let receipt = await this.receipt(input);
    if (!receipt) {
      // A concurrent copy of this request was refused and dropped the
      // receipt while this one passed its checks: write it again.
      await this.db.run(
        `INSERT OR IGNORE INTO channel_requests
        (binding_id, request_id, request_hash, run_id, created_at) VALUES (?, ?, ?, ?, ?)`,
        [input.bindingId, input.requestId, requestHash, runId, this.now()],
      );
      receipt = await this.receipt(input);
    }
    if (!receipt || receipt.request_hash !== requestHash)
      throw new ChannelError(
        409,
        'This request ID already belongs to another message',
        'request_conflict',
      );
    let session = receipt.session_id ?? sessionId;
    if (
      !receipt.session_id &&
      routing?.mode === 'on' &&
      (await this.routingState(input.bindingId)).generation !==
        routing.generation
    ) {
      // An explicit /new or /resume completed while this request was being
      // classified: the user's choice wins. The request runs as with
      // routing off, in the session the control bound.
      await this.db.run(
        'UPDATE channel_requests SET routing_json=NULL WHERE run_id=?',
        [runId],
      );
      await this.host.changed();
      routing = undefined;
      session = (await this.boundSession(input.bindingId)) ?? sessionId;
    } else if (!receipt.session_id && routing?.mode === 'on') {
      await this.db.run(
        'INSERT INTO channel_sessions(binding_id,session_id) VALUES(?,?) ON CONFLICT(binding_id) DO UPDATE SET session_id=excluded.session_id,force_next=0',
        [input.bindingId, sessionId],
      );
    } else if (!receipt.session_id) {
      // Routing off, or in shadow (which never switches the session).
      await this.db.run(
        'INSERT OR IGNORE INTO channel_sessions (binding_id, session_id) VALUES (?, ?)',
        [input.bindingId, sessionId],
      );
      const bound = await this.boundSession(input.bindingId);
      if (bound && bound !== sessionId) {
        // Another request bound the binding while this one was checked.
        if (input.sessionId) {
          await this.dropReceipt(runId);
          throw new ChannelError(
            409,
            'This channel already has another session',
            'session_conflict',
          );
        }
        session = bound;
      }
    }
    this.opening.delete(input.bindingId);
    const record = await this.host.getRun(runId);
    if (record) {
      // A concurrent copy of this request started the run.
      if (!receipt.session_id) {
        await this.db.run(
          'UPDATE channel_requests SET session_id = ? WHERE run_id = ?',
          [session, runId],
        );
        await this.host.changed();
      }
      return this.respond(input, receipt, session, record);
    }
    // The run owes its user message to the user's oracle room from here on;
    // the mirror pass sends it, the turn never waits for it.
    await this.db.run(
      `UPDATE channel_requests SET session_id = ?, user_mirrored = 0, reply_mirrored = 0,
         mirror_pending = 1, mirror_failures = 0, mirror_retry_at = NULL
       WHERE run_id = ?`,
      [session, runId],
    );
    await this.host.changed();
    await this.recordSessionBinding(input, session);
    await this.db.run(
      'UPDATE channel_sessions SET force_next=0 WHERE binding_id=? AND force_next<>0',
      [input.bindingId],
    );
    if (this.routingEnabled(input) && routing?.destination.kind !== 'clarify')
      await this.indexThread(input, session, runId);
    const replyContext = await this.replyContext(input, session);
    const started = await this.host.begin(runId, {
      identity,
      sessionId: session,
      message: input.message,
      client: 'channel',
      requestId: input.requestId,
      multitask: 'enqueue',
      channel: {
        provider: input.provider,
        bindingId: input.bindingId,
        bindingRevision: input.bindingRevision,
        remoteMessageRef: input.remoteMessageRef,
        ...(replyContext ? { replyContext } : {}),
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        ...(routing?.destination.kind === 'clarify'
          ? { routingClarification: routing.destination.text }
          : {}),
      },
    });
    this.kick();
    return this.respond(input, null, session, started);
  }

  /**
   * The answer for a request whose run exists. A finished run is answered
   * with its reply at once; whatever the room is still owed (by this
   * receipt) is mirrored in the background.
   */
  private async respond(
    input: ChannelTurnInput,
    receipt: ReceiptRow | null,
    sessionId: string,
    record: RunRecord,
  ): Promise<ChannelTurnResponse> {
    const reply =
      record.status === 'finished'
        ? await this.reply(record.runId, record.partialText ?? '')
        : null;
    // A mirror this request still owes and that is due: its user message,
    // or the reply of a run that ended (a running run owes it later).
    if (
      receipt &&
      Number(receipt.mirror_pending) === 1 &&
      (receipt.mirror_retry_at === null ||
        Number(receipt.mirror_retry_at) <= this.now()) &&
      (Number(receipt.user_mirrored) === 0 ||
        TERMINAL_STATUSES.has(record.status))
    )
      this.kick();
    return {
      requestId: input.requestId,
      runId: record.runId,
      sessionId,
      sessionTitle: await this.titleOf(sessionId),
      status: record.status,
      ...(record.messageId ? { messageId: record.messageId } : {}),
      // `text` is the whole reply as one message for gateways that predate
      // plans: the rendered plan when there is one (it carries the artefact
      // links), else the model's text.
      ...(reply ? { text: reply.rendered } : {}),
      ...(reply?.plan ? { plan: reply.plan } : {}),
    };
  }

  /** Start a mirror pass, or ask the running one to go again. */
  private kick(): void {
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    const work = (async () => {
      do {
        this.drainAgain = false;
        await this.drainOnce();
      } while (this.drainAgain);
    })()
      .catch((error: unknown) => {
        console.warn(`[channels] room mirror pass failed: ${errorText(error)}`);
      })
      .finally(() => {
        this.draining = null;
      });
    this.draining = work;
    this.host.keepAlive(work);
  }

  /**
   * One mirror pass over the receipts that owe the user's oracle room a
   * message. Sessions are mirrored in parallel; within a session strictly
   * in receipt order, the user message before its reply, and a mirror that
   * fails holds the session's later ones back until it succeeds or is
   * abandoned, so the room keeps the order of the conversation.
   */
  private async drainOnce(): Promise<void> {
    await this.setup();
    const rows = await this.db.exec<ReceiptRow>(
      'SELECT * FROM channel_requests WHERE mirror_pending = 1 ORDER BY rowid LIMIT ?',
      [MIRROR_SCAN_BATCH],
    );
    const sessions = new Map<string, ReceiptRow[]>();
    for (const row of rows) {
      const key = row.session_id ?? '';
      sessions.set(key, [...(sessions.get(key) ?? []), row]);
    }
    await Promise.all(
      [...sessions.values()].map((owed) => this.drainSession(owed)),
    );
  }

  private async drainSession(rows: ReceiptRow[]): Promise<void> {
    for (const row of rows) {
      const retryAt =
        row.mirror_retry_at === null ? null : Number(row.mirror_retry_at);
      if (retryAt !== null && retryAt > this.now()) {
        this.host.scheduleRetry(retryAt);
        return;
      }
      const record = await this.host.getRun(row.run_id);
      // No run yet: admission marks the mirror owed just before the run
      // begins (so a reset in between cannot lose it), and this pass may
      // run in that gap. Left as it is; a receipt whose run never began is
      // pruned with the others (`housekeeping`).
      if (!record) continue;
      if (
        this.routing &&
        this.routing.mode !== 'off' &&
        record.status === 'finished'
      ) {
        const refreshed = await this.db.run(
          'UPDATE channel_thread_index SET recent_reply=? WHERE last_run_id=?',
          [(record.partialText ?? '').slice(0, 800), row.run_id],
        );
        if (refreshed.changes > 0) await this.host.changed();
      }
      const request = this.host.requestOf(record);
      let author: 'user' | 'oracle' = 'user';
      try {
        if (Number(row.user_mirrored) === 0) {
          await this.host.mirror(request, request.message, 'user');
          await this.settleMirror(row.run_id, 'user_mirrored = 1');
        }
        if (Number(row.reply_mirrored) === 0) {
          if (record.status === 'finished') {
            author = 'oracle';
            // The reply as the channel user received it: a run with a
            // Reply Plan mirrors the plan, else the model's text.
            const reply = await this.reply(
              record.runId,
              record.partialText ?? '',
            );
            await this.host.mirror(request, reply.rendered, 'oracle');
            await this.settleMirror(
              row.run_id,
              'reply_mirrored = 1, mirror_pending = 0',
            );
          } else if (TERMINAL_STATUSES.has(record.status)) {
            await this.settleMirror(
              row.run_id,
              'reply_mirrored = 2, mirror_pending = 0',
            );
          }
          // Still running: the reply is mirrored when the run ends.
        } else {
          await this.settleMirror(row.run_id, 'mirror_pending = 0');
        }
      } catch (error) {
        await this.mirrorFailed(row, author, error);
        return;
      }
    }
  }

  private async settleMirror(runId: string, set: string): Promise<void> {
    await this.db.run(
      `UPDATE channel_requests SET ${set}, mirror_failures = 0, mirror_retry_at = NULL WHERE run_id = ?`,
      [runId],
    );
    await this.host.changed();
  }

  /**
   * Record a failed mirror: retry it later with backoff, or abandon it
   * (log it and stop owing it) once the homeserver refused the oracle in
   * the room or the attempts are spent. Never surfaces to a turn or poll.
   */
  private async mirrorFailed(
    row: ReceiptRow,
    author: 'user' | 'oracle',
    error: unknown,
  ): Promise<void> {
    const failures = Number(row.mirror_failures) + 1;
    const forbidden = isRoomForbidden(error);
    const what = `author=${author} run=${row.run_id} session=${row.session_id ?? '-'} attempt=${failures}`;
    if (forbidden || failures >= CHANNEL_MIRROR_MAX_FAILURES) {
      await this.db.run(
        'UPDATE channel_requests SET mirror_pending = 0, mirror_failures = ?, mirror_retry_at = NULL WHERE run_id = ?',
        [failures, row.run_id],
      );
      await this.host.changed();
      console.error(
        `[channels] channel_mirror_abandoned=1 ${what} reason=${forbidden ? 'room_forbidden' : 'attempts_spent'}: ${errorText(error)}`,
      );
      return;
    }
    const retryAt =
      this.now() +
      Math.min(
        CHANNEL_MIRROR_RETRY_BASE_MS * 2 ** (failures - 1),
        CHANNEL_MIRROR_RETRY_MAX_MS,
      );
    await this.db.run(
      'UPDATE channel_requests SET mirror_failures = ?, mirror_retry_at = ? WHERE run_id = ?',
      [failures, retryAt, row.run_id],
    );
    await this.host.changed();
    this.host.scheduleRetry(retryAt);
    console.warn(
      `[channels] channel_mirror_failed=1 ${what} retry_at=${new Date(retryAt).toISOString()}: ${errorText(error)}`,
    );
  }
}

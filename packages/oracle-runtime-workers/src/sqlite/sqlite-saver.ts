/* eslint-disable no-console -- console replaces the Node runtime's @ixo/logger Logger on workerd */
/**
 * LangGraph checkpointer over `DoSqliteDatabase` — a port of the Node
 * runtime's `@ixo/sqlite-saver` (better-sqlite3) with the SAME schema and
 * semantics. Compatibility is one-way: a `.db` written by the Node runtime
 * opens here unchanged, but blobs THIS runtime writes are gzipped
 * (`blob-codec.ts` — lossless, detected by magic bytes on read), which the
 * Node runtime does not understand. Schema:
 *
 *   checkpoints(thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
 *               type, checkpoint BLOB, metadata BLOB)
 *   writes(thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel,
 *          type, value BLOB, task_path)
 *   messages(thread_id, checkpoint_ns, checkpoint_id, message_id PK,
 *            message_type, message_content, message BLOB, created_at)
 *   schema_migrations(version PK, name, applied_at)
 *   attachment_payload_sweeps(thread_id PK, swept_at)
 *
 * Behaviour kept from the original:
 * - `channel_values.messages` is stripped from the stored checkpoint and each
 *   message is upserted into `messages` (keyed by message id, so the table is
 *   the full transcript: rows survive checkpoint pruning and summarization).
 *   An unchanged message keeps its row in place (see `writeMessageRows`).
 * - `put` prunes a thread to `maxCheckpointsPerThread` newest checkpoints (and
 *   their writes) once it exceeds the cap by `PRUNE_SLACK`.
 * - `pending_sends` migration for pre-v4 checkpoints.
 * - Pending writes keep the task path `putWrites` is given and are returned
 *   in `writesSortKey` order, `(task_path, task_id, idx)`, sorted in JS with
 *   `compareWritesSortKeys` as the upstream savers do. Rows written before
 *   the column existed read with path `''` and sort first, by task id.
 * - Serialization is `JsonPlusSerializer` (the `BaseCheckpointSaver` default).
 *
 * Attachment bytes are never stored: every write path (message rows, the
 * checkpoint blob's channel values, pending writes) stores a human message
 * that carries inline base64 blocks as its placeholder copy
 * (`inline-payloads.ts`), while the run's in-memory state keeps the blocks.
 * Whatever reads the database back — the next turn, a durable run resumed
 * after a reset, the transcript, the owner copy — sees the placeholder.
 * Human message rows written before that (with their bytes) are rewritten
 * once per thread, on the thread's first load (`sweepInlinePayloads`; the
 * thread is then recorded in `attachment_payload_sweeps`). A write whose
 * serialized form still holds a payload block is logged
 * (`containsInlinePayload`): tool and AI messages are never stripped.
 *
 * Differences: everything is async (wa-sqlite API), `console` replaces the
 * `@ixo/logger` Logger, the oracle name stamped on messages comes from
 * `options.oracleName` instead of `process.env`, and each `put`/`putWrites`/
 * `deleteThread` runs inside a `DoSqliteDatabase.transaction` — which the VFS
 * commits to DO storage atomically.
 */
import type { BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  compareWritesSortKeys,
  copyCheckpoint,
  emptyCheckpoint,
  maxChannelVersion,
  type PendingWrite,
  type SerializerProtocol,
  TASKS,
  writesSortKey,
} from '@langchain/langgraph-checkpoint';
import { compressForStorage, hexToBytes, readBlobText } from './blob-codec';
import type { DoSqliteDatabase, SqlParam } from './database';
import {
  _default,
  cleanAdditionalKwargs,
  stringify,
  type CleanAdditionalKwargs,
} from './serialization';
import {
  containsInlinePayload,
  INLINE_PAYLOAD_NEEDLE,
  withoutInlinePayloads,
} from './inline-payloads';
import {
  hasInlinePayload,
  offloadInlinePayloads,
} from '../attachments/retention';

export interface SqliteSaverOptions {
  /**
   * Newest checkpoints retained per thread after each `put`. LangGraph writes
   * one checkpoint per super-step and never deletes them; without a cap a
   * long-lived thread's tables grow without bound. `0` disables pruning.
   */
  maxCheckpointsPerThread?: number;
  /** Stamped into every persisted message's `additional_kwargs.oracleName`. */
  oracleName?: string;
}

/**
 * Checkpoints kept per thread. Only the newest is read when a turn starts;
 * older ones exist for replay/time-travel (unused today) and for recovering
 * an interrupted step. Ten (the Node default is twenty) roughly halves the
 * two largest tables of a busy user's file (`checkpoints` + `writes`); raise
 * it again once the per-object 10 GB ceiling is no longer the constraint.
 */
export const DEFAULT_MAX_CHECKPOINTS_PER_THREAD = 10;

/** Pruning only runs once a thread exceeds the cap by this many checkpoints. */
export const PRUNE_SLACK = 5;

const DEFAULT_ORACLE_NAME = 'IXO Oracle';

/** Position of `message_id` in the parameter rows `toMessageRow` returns. */
const MESSAGE_ID_COLUMN = 3;

/**
 * What a message's stored row is encoded from, compared without
 * serializing the message: the identity of each field that can be large
 * (state updates replace a changed message with a new object or new field
 * values; nothing edits a stored message's content in place) and the JSON
 * of the small normalized `additional_kwargs`.
 */
interface MessageFingerprint {
  id: unknown;
  type: string;
  content: unknown;
  toolCalls: unknown;
  invalidToolCalls: unknown;
  artifact: unknown;
  responseMetadata: unknown;
  usageMetadata: unknown;
  name: unknown;
  toolCallId: unknown;
  status: unknown;
  kwargs: string;
}

function fingerprintOf(
  message: BaseMessage,
  kwargs: CleanAdditionalKwargs,
): MessageFingerprint {
  return {
    id: message.id,
    type: message.getType(),
    content: message.content,
    toolCalls: Reflect.get(message, 'tool_calls'),
    invalidToolCalls: Reflect.get(message, 'invalid_tool_calls'),
    artifact: Reflect.get(message, 'artifact'),
    responseMetadata: message.response_metadata,
    usageMetadata: Reflect.get(message, 'usage_metadata'),
    name: message.name,
    toolCallId: Reflect.get(message, 'tool_call_id'),
    status: Reflect.get(message, 'status'),
    kwargs: stringify(kwargs, (_key, value) => _default(value)),
  };
}

function sameFingerprint(
  a: MessageFingerprint,
  b: MessageFingerprint,
): boolean {
  return (
    a.id === b.id &&
    a.type === b.type &&
    a.content === b.content &&
    a.toolCalls === b.toolCalls &&
    a.invalidToolCalls === b.invalidToolCalls &&
    a.artifact === b.artifact &&
    a.responseMetadata === b.responseMetadata &&
    a.usageMetadata === b.usageMetadata &&
    a.name === b.name &&
    a.toolCallId === b.toolCallId &&
    a.status === b.status &&
    a.kwargs === b.kwargs
  );
}

/**
 * The stored form of one message object: the fingerprint it was encoded
 * from, its blob and, when the stored form is a placeholder copy (inline
 * attachment bytes left out), that copy's `message_content` text.
 */
interface EncodedMessage {
  fingerprint: MessageFingerprint;
  blob: Uint8Array;
  storedContent?: string;
}

/** A message's row parameters, and whether its stored row already holds them. */
interface EncodedMessageRow {
  row: SqlParam[];
  unchanged: boolean;
}

type CheckpointRow = {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  type: string | null;
  checkpoint: Uint8Array | string;
  metadata: Uint8Array | string;
  pending_writes: string;
};

type MessageRow = {
  message: Uint8Array | string;
};

/** A transcript row's position in the listing order. */
export interface ThreadMessageAnchor {
  createdAt: string;
  rowid: number;
}

/** A transcript row with what a pager needs to continue from it. */
export interface ThreadMessageRow {
  message: BaseMessage;
  messageId: string;
  anchor: ThreadMessageAnchor;
}

interface PendingWriteColumn {
  task_id: string;
  /** `''` on rows written before migration 004 and on writes without a task. */
  task_path: string;
  idx: number;
  channel: string;
  type: string | null;
  /** `hex(value)` — decoded via {@link hexColumnText}. */
  value: string | null;
}

interface PendingSendColumn {
  type: string;
  /** `hex(value)` — decoded via {@link hexColumnText}. */
  value: string | null;
}

interface Migration {
  version: number;
  name: string;
  up: (db: DoSqliteDatabase) => Promise<void>;
}

type ChannelValues = Record<string, unknown>;

interface CheckpointWithMessages extends Checkpoint {
  channel_values: ChannelValues & { messages?: BaseMessage[] };
}

/**
 * Compile-time guard: the metadata keys `list()` accepts as filters must stay
 * in sync with `CheckpointMetadata`. If this stops compiling, update the list.
 */
const checkpointMetadataKeys = [
  'source',
  'step',
  'parents',
  'counters_since_delta_snapshot',
] as const;
type MetadataKey = keyof CheckpointMetadata;
type CheckKeys<K extends readonly MetadataKey[]> = [MetadataKey] extends [
  K[number],
]
  ? K
  : never;
const validCheckpointMetadataKeys: readonly string[] = ((
  keys: CheckKeys<typeof checkpointMetadataKeys>,
) => keys)(checkpointMetadataKeys);

/** Migration 001: `messages.created_at` (older files lack it) plus its index. */
const migration001: Migration = {
  version: 1,
  name: 'add_created_at_to_messages',
  up: async (db) => {
    const columns = await db.exec<{ name: string }>(
      `SELECT name FROM pragma_table_info('messages') WHERE name = ?`,
      ['created_at'],
    );
    if (columns.length === 0) {
      await db.run(
        `ALTER TABLE messages ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      );
      await db.run(
        `UPDATE messages SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL`,
      );
    }
    const index = await db.get<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_thread_created'`,
    );
    if (index === undefined) {
      await db.run(
        `CREATE INDEX idx_messages_thread_created ON messages(thread_id, created_at)`,
      );
    }
  },
};

/**
 * Migration 002: drop `idx_messages_thread_id` and `idx_messages_checkpoint_id`.
 * No query uses them — every `messages` query filters on `thread_id` (served
 * by `idx_messages_thread_created` / `idx_messages_lookup`, whose leading
 * column it is) or looks a row up by `message_id` — yet every message write
 * updated both b-trees.
 */
const migration002: Migration = {
  version: 2,
  name: 'drop_unused_message_indexes',
  up: async (db) => {
    await db.run('DROP INDEX IF EXISTS idx_messages_thread_id');
    await db.run('DROP INDEX IF EXISTS idx_messages_checkpoint_id');
  },
};

/**
 * Migration 003: `attachment_payload_sweeps`, the threads whose human
 * message rows no longer hold inline attachment bytes (see
 * `sweepInlinePayloads`).
 */
const migration003: Migration = {
  version: 3,
  name: 'add_attachment_payload_sweeps',
  up: async (db) => {
    await db.run(`
      CREATE TABLE IF NOT EXISTS attachment_payload_sweeps (
        thread_id TEXT NOT NULL PRIMARY KEY,
        swept_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
  },
};

/**
 * Migration 004: `writes.task_path`, the serialized path of the task that
 * made a write (`putWrites`), the first part of the order pending writes
 * are returned in. `ADD COLUMN` with a constant default only rewrites the
 * table's entry in `sqlite_schema`: existing rows are not touched and read
 * the default `''`, so the migration costs the same on any file size. A
 * file created after this release already has the column (see `doSetup`).
 */
const migration004: Migration = {
  version: 4,
  name: 'add_task_path_to_writes',
  up: async (db) => {
    const columns = await db.exec<{ name: string }>(
      `SELECT name FROM pragma_table_info('writes') WHERE name = ?`,
      ['task_path'],
    );
    if (columns.length === 0) {
      await db.run(
        `ALTER TABLE writes ADD COLUMN task_path TEXT NOT NULL DEFAULT ''`,
      );
    }
  },
};

const MIGRATIONS: readonly Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
];

/** Rows the one-time attachment sweep inflates and rewrites per transaction. */
const SWEEP_BATCH_ROWS = 8;

// `writes.value` blobs may be gzipped, so they travel as hex() — a
// CAST(... AS TEXT) of compressed bytes would mangle them irreversibly.
const TUPLE_SELECT = `
  SELECT
    thread_id,
    checkpoint_ns,
    checkpoint_id,
    parent_checkpoint_id,
    type,
    checkpoint,
    metadata,
    (
      SELECT json_group_array(
        json_object('task_id', pw.task_id, 'task_path', pw.task_path, 'idx', pw.idx, 'channel', pw.channel, 'type', pw.type, 'value', hex(pw.value))
      )
      FROM writes AS pw
      WHERE pw.thread_id = checkpoints.thread_id
        AND pw.checkpoint_ns = checkpoints.checkpoint_ns
        AND pw.checkpoint_id = checkpoints.checkpoint_id
    ) AS pending_writes
  FROM checkpoints`;

/**
 * A `hex(column)` value from a tuple query back to its JSON text. `hex(NULL)`
 * yields an empty string; codec-written blobs gunzip transparently.
 */
async function hexColumnText(hex: string | null): Promise<string> {
  if (hex === null || hex.length === 0) return '';
  return readBlobText(hexToBytes(hex));
}

/** `LIKE` pattern matching rows whose column contains `needle` literally. */
function likeContains(needle: string): string {
  return `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export class SqliteSaver extends BaseCheckpointSaver {
  readonly db: DoSqliteDatabase;
  protected readonly maxCheckpointsPerThread: number;
  protected readonly oracleName: string;
  private setupPromise: Promise<void> | undefined;
  /**
   * The stored blob of each message object last encoded or loaded, with the
   * fingerprint of what it was encoded from. LangGraph hands the same
   * message objects to every `put` of a run, and the checkpoint a turn
   * starts from is loaded from these rows: a message whose fingerprint is
   * unchanged reuses its blob and is neither serialized nor compressed
   * again, and its row is only re-keyed to the new checkpoint
   * (`writeMessageRows`). Re-serializing every message on every `put` held
   * a second copy of the whole thread (the cached JSON) and allocated a
   * third one per step — on a long thread, the peak that reset a 128 MB
   * isolate at the end of a tool turn.
   */
  private readonly encoded = new WeakMap<BaseMessage, EncodedMessage>();
  /** Threads known to hold no inline attachment bytes in their rows. */
  private readonly sweptThreads = new Set<string>();
  /** The sweep in progress per thread: concurrent loads share it. */
  private readonly sweeps = new Map<string, Promise<void>>();

  constructor(
    db: DoSqliteDatabase,
    serde?: SerializerProtocol,
    options: SqliteSaverOptions = {},
  ) {
    super(serde);
    this.db = db;
    this.maxCheckpointsPerThread =
      options.maxCheckpointsPerThread ?? DEFAULT_MAX_CHECKPOINTS_PER_THREAD;
    this.oracleName = options.oracleName ?? DEFAULT_ORACLE_NAME;
  }

  /** Create tables/indexes and run pending migrations. Idempotent; concurrent callers share one run. */
  setup(): Promise<void> {
    this.setupPromise ??= this.doSetup().catch((error: unknown) => {
      this.setupPromise = undefined;
      throw error;
    });
    return this.setupPromise;
  }

  private async doSetup(): Promise<void> {
    const db = this.db;
    // Incremental auto-vacuum lets pruning hand freed pages back so the file
    // (what gets exported to the owner store) doesn't sit at its high-water
    // mark. Binds immediately on a new database (runs before the first table);
    // on an existing NONE-mode file it needs a full VACUUM, done elsewhere.
    const autoVacuum = await db.get<{ auto_vacuum: number }>(
      'PRAGMA auto_vacuum',
    );
    if (autoVacuum !== undefined && autoVacuum.auto_vacuum !== 2) {
      await db.run('PRAGMA auto_vacuum = INCREMENTAL');
    }
    await db.run(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        type TEXT,
        checkpoint BLOB,
        metadata BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      )`);
    await db.run(`
      CREATE TABLE IF NOT EXISTS writes (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        channel TEXT NOT NULL,
        type TEXT,
        value BLOB,
        task_path TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      )`);
    await db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        message_type TEXT NOT NULL,
        message_content TEXT NOT NULL,
        message BLOB,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (message_id)
      )`);
    await this.runMigrations();
    await db.run(
      `CREATE INDEX IF NOT EXISTS idx_messages_lookup ON messages(thread_id, checkpoint_ns, checkpoint_id)`,
    );
    await db.run(
      `CREATE INDEX IF NOT EXISTS idx_messages_thread_created ON messages(thread_id, created_at)`,
    );
    await db.run(
      `CREATE INDEX IF NOT EXISTS idx_writes_channel ON writes(thread_id, checkpoint_id, channel)`,
    );
  }

  private async runMigrations(): Promise<void> {
    const db = this.db;
    await db.run(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER NOT NULL PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
    const applied = new Set(
      (
        await db.exec<{ version: number }>(
          'SELECT version FROM schema_migrations ORDER BY version',
        )
      ).map((row) => row.version),
    );
    const pending = MIGRATIONS.filter((m) => !applied.has(m.version)).sort(
      (a, b) => a.version - b.version,
    );
    if (pending.length === 0) return;
    console.info(
      `[sqlite-saver] running ${pending.length} pending migration(s)`,
    );
    for (const migration of pending) {
      try {
        await db.transaction(async () => {
          await migration.up(db);
          await db.run(
            'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
            [migration.version, migration.name],
          );
        });
        console.info(
          `[sqlite-saver] migration ${migration.version}: ${migration.name} applied`,
        );
      } catch (error) {
        console.error(
          `[sqlite-saver] migration ${migration.version}: ${migration.name} failed`,
          error,
        );
        throw error;
      }
    }
  }

  /**
   * Every message ever written for a thread, oldest first, independent of
   * which checkpoint currently references it (the full transcript, even after
   * summarization condensed the graph state).
   */
  async listThreadMessages(threadId: string): Promise<BaseMessage[]> {
    await this.setup();
    await this.ensureSwept(threadId);
    const rows = await this.db.exec<MessageRow>(
      'SELECT message FROM messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC',
      [threadId],
    );
    return Promise.all(rows.map((row) => this.loadMessage(row.message)));
  }

  /**
   * The thread's newest human and AI rows with stored content, newest first.
   * `limit` bounds the rows decoded, so the read stays O(limit) in a long
   * thread, unlike `listThreadMessages`.
   */
  async listRecentThreadMessages(
    threadId: string,
    limit: number,
  ): Promise<BaseMessage[]> {
    await this.setup();
    const rows = await this.db.exec<MessageRow>(
      `SELECT message FROM messages WHERE thread_id = ? AND message_type IN ('human', 'ai') AND message_content <> '' ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      [threadId, limit],
    );
    return Promise.all(rows.map((row) => this.loadMessage(row.message)));
  }

  /**
   * Where a transcript row sits in the listing order (`created_at`, then
   * `rowid`), or null when the thread has no row with that message id. A
   * paging cursor names a message id and is resolved through this at query
   * time: rowids move when a checkpoint rewrites the thread's rows, message
   * ids never do.
   */
  async findThreadMessageAnchor(
    threadId: string,
    messageId: string,
  ): Promise<ThreadMessageAnchor | null> {
    await this.setup();
    const row = await this.db.get<{ created_at: string; rowid: number }>(
      'SELECT created_at, rowid FROM messages WHERE thread_id = ? AND message_id = ?',
      [threadId, messageId],
    );
    return row ? { createdAt: row.created_at, rowid: row.rowid } : null;
  }

  /**
   * A slice of the transcript next to an anchor: `older` walks back from it
   * (newest first, so a caller can stop once it holds enough turns), `newer`
   * walks forward (oldest first). Without an anchor `older` starts at the
   * newest row and `newer` at the oldest. The anchor row itself is left out
   * unless `inclusive`.
   */
  async listThreadMessageRows(
    threadId: string,
    opts: {
      direction: 'older' | 'newer';
      anchor?: ThreadMessageAnchor | null;
      /** Include the anchor row itself. */
      inclusive?: boolean;
      limit: number;
    },
  ): Promise<ThreadMessageRow[]> {
    await this.setup();
    await this.ensureSwept(threadId);
    const older = opts.direction === 'older';
    const cmp = older ? '<' : '>';
    const rowCmp = opts.inclusive ? `${cmp}=` : cmp;
    const order = older ? 'DESC' : 'ASC';
    const anchored = opts.anchor
      ? ` AND (created_at ${cmp} ? OR (created_at = ? AND rowid ${rowCmp} ?))`
      : '';
    const rows = await this.db.exec<{
      message: Uint8Array | string;
      message_id: string;
      created_at: string;
      rowid: number;
    }>(
      `SELECT message, message_id, created_at, rowid FROM messages WHERE thread_id = ?${anchored} ORDER BY created_at ${order}, rowid ${order} LIMIT ?`,
      [
        threadId,
        ...(opts.anchor
          ? [opts.anchor.createdAt, opts.anchor.createdAt, opts.anchor.rowid]
          : []),
        opts.limit,
      ],
    );
    return Promise.all(
      rows.map(async (row) => ({
        message: await this.loadMessage(row.message),
        messageId: row.message_id,
        anchor: { createdAt: row.created_at, rowid: row.rowid },
      })),
    );
  }

  /**
   * The thread's messages whose stored plain content (`message_content`)
   * contains `contentContains`, oldest first — a SQL `LIKE` pre-filter, so
   * only the matching rows' blobs are inflated. `view_attachment` uses it to
   * find the messages that quote an attachment reference.
   */
  async listThreadMessagesMatching(
    threadId: string,
    filter: { messageType?: string; contentContains: string },
  ): Promise<BaseMessage[]> {
    await this.setup();
    const rows = await this.db.exec<MessageRow>(
      `SELECT message FROM messages WHERE thread_id = ?${
        filter.messageType !== undefined ? ' AND message_type = ?' : ''
      } AND message_content LIKE ? ESCAPE '\\' ORDER BY created_at ASC, rowid ASC`,
      [
        threadId,
        ...(filter.messageType !== undefined ? [filter.messageType] : []),
        likeContains(filter.contentContains),
      ],
    );
    return Promise.all(rows.map((row) => this.loadMessage(row.message)));
  }

  /** Whether `listThreadMessagesMatching` would return anything (no blob inflation). */
  async hasThreadMessageMatching(
    threadId: string,
    filter: { messageType?: string; contentContains: string },
  ): Promise<boolean> {
    await this.setup();
    const rows = await this.db.exec<{ found: number }>(
      `SELECT 1 AS found FROM messages WHERE thread_id = ?${
        filter.messageType !== undefined ? ' AND message_type = ?' : ''
      } AND message_content LIKE ? ESCAPE '\\' LIMIT 1`,
      [
        threadId,
        ...(filter.messageType !== undefined ? [filter.messageType] : []),
        likeContains(filter.contentContains),
      ],
    );
    return rows.length > 0;
  }

  /**
   * Run the thread's one-time attachment sweep unless it ran already (in
   * this object, or recorded in `attachment_payload_sweeps`). A failed
   * sweep is logged and left for the next load; the read goes on.
   */
  private ensureSwept(threadId: string): Promise<void> {
    if (this.sweptThreads.has(threadId)) return Promise.resolve();
    const running = this.sweeps.get(threadId);
    if (running) return running;
    const sweep = this.sweepInlinePayloads(threadId)
      .then(
        () => {
          this.sweptThreads.add(threadId);
        },
        (error: unknown) => {
          console.warn(
            `[sqlite-saver] thread ${threadId}: attachment sweep failed, retried on the next load`,
            error,
          );
        },
      )
      .finally(() => {
        this.sweeps.delete(threadId);
      });
    this.sweeps.set(threadId, sweep);
    return sweep;
  }

  /**
   * Rewrite the thread's human message rows that still hold inline
   * attachment bytes (written before the saver left them out) as their
   * placeholder copy, then record the thread as swept. Rows summarised out
   * of graph state are never written again, so without this their bytes
   * would stay in the transcript and the owner copy for good. The matching
   * rows are found by their `message_content` (no blob inflated for the
   * rest) and rewritten `SWEEP_BATCH_ROWS` at a time, each row in place
   * (same rowid, checkpoint linkage, `created_at` and kwargs). Tool and AI
   * messages are left as they are (see `inline-payloads.ts`).
   */
  private async sweepInlinePayloads(threadId: string): Promise<void> {
    const swept = await this.db.get<{ found: number }>(
      'SELECT 1 AS found FROM attachment_payload_sweeps WHERE thread_id = ?',
      [threadId],
    );
    if (swept !== undefined) return;
    const needle = likeContains(INLINE_PAYLOAD_NEEDLE);
    const matching = await this.db.exec<{ rowid: number }>(
      `SELECT rowid FROM messages WHERE thread_id = ? AND message_type = 'human' AND message_content LIKE ? ESCAPE '\\' ORDER BY rowid`,
      [threadId, needle],
    );
    let rewritten = 0;
    for (let i = 0; i < matching.length; i += SWEEP_BATCH_ROWS) {
      const batch = matching.slice(i, i + SWEEP_BATCH_ROWS).map((r) => r.rowid);
      const rows = await this.db.exec<{
        rowid: number;
        message_id: string;
        message: Uint8Array | string;
      }>(
        'SELECT rowid, message_id, message FROM messages WHERE rowid IN (SELECT value FROM json_each(?))',
        [JSON.stringify(batch)],
      );
      const updates: SqlParam[][] = [];
      for (const row of rows) {
        const placeholder = offloadInlinePayloads(
          await this.loadMessage(row.message),
        );
        if (!placeholder) continue;
        updates.push([
          contentColumn(placeholder.content),
          await compressForStorage(
            stringify(placeholder, (_key, value) => _default(value)),
          ),
          row.rowid,
          row.message_id,
          needle,
        ]);
      }
      if (updates.length === 0) continue;
      await this.db.transaction(async () => {
        for (const update of updates) {
          // Only a row that is still the one read: same message, bytes
          // still in it (a `put` in between stored its placeholder).
          const result = await this.db.run(
            `UPDATE messages SET message_content = ?, message = ? WHERE rowid = ? AND message_id = ? AND message_content LIKE ? ESCAPE '\\'`,
            update,
          );
          rewritten += result.changes;
        }
      });
    }
    await this.db.run(
      'INSERT OR IGNORE INTO attachment_payload_sweeps (thread_id) VALUES (?)',
      [threadId],
    );
    if (matching.length > 0)
      console.info(
        `[sqlite-saver] thread ${threadId}: ${rewritten} of ${matching.length} stored human message(s) with inline attachment bytes rewritten as their placeholder`,
      );
  }

  private async loadMessage(raw: Uint8Array | string): Promise<BaseMessage> {
    return (await this.serde.loadsTyped(
      'json',
      await readBlobText(raw),
    )) as BaseMessage;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    return this.loadTuple(config, true);
  }

  /**
   * Like `getTuple` but skips the `messages` join and its per-message
   * deserialization — O(1) in conversation length. The returned checkpoint's
   * `channel_values.messages` is left unset.
   */
  async getTupleWithoutMessages(
    config: RunnableConfig,
  ): Promise<CheckpointTuple | undefined> {
    return this.loadTuple(config, false);
  }

  protected async loadTuple(
    config: RunnableConfig,
    includeMessages: boolean,
  ): Promise<CheckpointTuple | undefined> {
    await this.setup();
    const configurable = config.configurable ?? {};
    const threadId: unknown = configurable.thread_id;
    const checkpointNs: unknown = configurable.checkpoint_ns ?? '';
    const checkpointId: unknown = configurable.checkpoint_id;
    if (typeof threadId !== 'string' || typeof checkpointNs !== 'string')
      return undefined;
    await this.ensureSwept(threadId);

    const row =
      typeof checkpointId === 'string' && checkpointId.length > 0
        ? await this.db.get<CheckpointRow>(
            `${TUPLE_SELECT} WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`,
            [threadId, checkpointNs, checkpointId],
          )
        : await this.db.get<CheckpointRow>(
            `${TUPLE_SELECT} WHERE thread_id = ? AND checkpoint_ns = ? ORDER BY checkpoint_id DESC LIMIT 1`,
            [threadId, checkpointNs],
          );
    if (row === undefined) return undefined;

    const finalConfig: RunnableConfig =
      typeof checkpointId === 'string' && checkpointId.length > 0
        ? config
        : {
            configurable: {
              thread_id: row.thread_id,
              checkpoint_ns: checkpointNs,
              checkpoint_id: row.checkpoint_id,
            },
          };

    const tuple = await this.rowToTuple(row, includeMessages, finalConfig);
    return tuple;
  }

  private async rowToTuple(
    row: CheckpointRow,
    includeMessages: boolean,
    config: RunnableConfig,
  ): Promise<CheckpointTuple> {
    const pendingWrites = await this.loadPendingWrites(row.pending_writes);
    const checkpoint = (await this.serde.loadsTyped(
      row.type ?? 'json',
      await readBlobText(row.checkpoint),
    )) as Checkpoint;
    if (includeMessages) {
      const messages = await this.loadCheckpointMessages(
        row.thread_id,
        row.checkpoint_ns,
        row.checkpoint_id,
      );
      if (messages.length > 0) checkpoint.channel_values.messages = messages;
    }
    if (checkpoint.v < 4 && row.parent_checkpoint_id !== null) {
      await this.migratePendingSends(
        checkpoint,
        row.thread_id,
        row.parent_checkpoint_id,
      );
    }
    const metadata = (await this.serde.loadsTyped(
      row.type ?? 'json',
      await readBlobText(row.metadata),
    )) as CheckpointMetadata;
    return {
      config,
      checkpoint,
      metadata,
      parentConfig:
        row.parent_checkpoint_id !== null
          ? {
              configurable: {
                thread_id: row.thread_id,
                checkpoint_ns: row.checkpoint_ns,
                checkpoint_id: row.parent_checkpoint_id,
              },
            }
          : undefined,
      pendingWrites,
    };
  }

  /**
   * A checkpoint's pending writes in `writesSortKey` order, the order live
   * execution applies a superstep's writes in. Sorted here, not in SQL, so
   * the order never depends on a collation or a query plan.
   */
  private async loadPendingWrites(
    json: string,
  ): Promise<Array<[string, string, unknown]>> {
    const columns = (JSON.parse(json) as PendingWriteColumn[])
      .map((column) => ({
        key: writesSortKey(column.task_path, column.task_id, column.idx),
        column,
      }))
      .sort((a, b) => compareWritesSortKeys(a.key, b.key))
      .map(({ column }) => column);
    return Promise.all(
      columns.map(
        async (write): Promise<[string, string, unknown]> => [
          write.task_id,
          write.channel,
          await this.serde.loadsTyped(
            write.type ?? 'json',
            await hexColumnText(write.value),
          ),
        ],
      ),
    );
  }

  private async loadCheckpointMessages(
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
  ): Promise<BaseMessage[]> {
    // Rowid order is the order of the checkpoint's message array (see
    // `writeMessageRows`); the lookup index already yields it, no sort.
    const rows = await this.db.exec<MessageRow>(
      'SELECT message FROM messages WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? ORDER BY rowid',
      [threadId, checkpointNs, checkpointId],
    );
    return Promise.all(
      rows.map(async (row) => {
        const message = await this.loadMessage(row.message);
        this.rememberLoaded(message, row.message);
        return message;
      }),
    );
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const { limit, before, filter } = options ?? {};
    await this.setup();
    const threadId: unknown = config.configurable?.thread_id;
    const checkpointNs: unknown = config.configurable?.checkpoint_ns;
    const beforeId: unknown = before?.configurable?.checkpoint_id;

    const where: string[] = [];
    const args: SqlParam[] = [];
    if (typeof threadId === 'string') {
      where.push('thread_id = ?');
      args.push(threadId);
    }
    if (typeof checkpointNs === 'string') {
      where.push('checkpoint_ns = ?');
      args.push(checkpointNs);
    }
    if (typeof beforeId === 'string') {
      where.push('checkpoint_id < ?');
      args.push(beforeId);
    }
    for (const [key, value] of Object.entries(filter ?? {})) {
      if (value === undefined || !validCheckpointMetadataKeys.includes(key))
        continue;
      // `->` yields the JSON text of the member, compared against the JSON text of the filter value.
      where.push(`json(CAST(metadata AS TEXT))->'$.${key}' = ?`);
      args.push(JSON.stringify(value));
    }

    let sql = TUPLE_SELECT;
    if (where.length > 0) sql += `\nWHERE ${where.join(' AND ')}`;
    sql += '\nORDER BY checkpoint_id DESC';
    if (limit !== undefined) {
      const parsed = Number.parseInt(String(limit), 10);
      if (Number.isFinite(parsed) && parsed > 0) sql += ` LIMIT ${parsed}`;
    }

    const rows = await this.db.exec<CheckpointRow>(sql, args);
    for (const row of rows) {
      yield this.rowToTuple(row, true, {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: row.checkpoint_ns,
          checkpoint_id: row.checkpoint_id,
        },
      });
    }
  }

  /** Append a deterministic turn without running or replacing pending graph work. */
  async appendTurnMessages(
    threadId: string,
    messages: BaseMessage[],
  ): Promise<void> {
    const config = { configurable: { thread_id: threadId } };
    const existing = await this.getTupleWithoutMessages(config);
    if (!existing) {
      const checkpoint = emptyCheckpoint();
      checkpoint.channel_values.messages = messages;
      await this.put(config, checkpoint, {
        source: 'update',
        step: -1,
        parents: {},
      });
      return;
    }
    const rows = await Promise.all(
      messages.map((message) =>
        this.toMessageRow(message, threadId, '', existing.checkpoint.id),
      ),
    );
    await this.db.transaction(async () => {
      for (const row of rows) {
        await this.db.run(
          `INSERT OR IGNORE INTO messages (thread_id, checkpoint_ns, checkpoint_id, message_id, message_type, message_content, message, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          row,
        );
      }
    });
  }

  async put(
    config: RunnableConfig,
    checkpointIn: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    await this.setup();
    if (!config.configurable) throw new Error('Empty configuration supplied.');
    const threadId: unknown = config.configurable.thread_id;
    const checkpointNs: unknown = config.configurable.checkpoint_ns ?? '';
    const parentCheckpointId: unknown = config.configurable.checkpoint_id;
    if (typeof threadId !== 'string' || threadId.length === 0) {
      throw new Error(
        `Missing "thread_id" field in passed "config.configurable".`,
      );
    }
    if (typeof checkpointNs !== 'string')
      throw new Error('"checkpoint_ns" must be a string.');

    const { checkpoint, messages } = toStoredCheckpoint(checkpointIn);
    const [[type1, serializedCheckpoint], [type2, serializedMetadata]] =
      await Promise.all([
        this.serde.dumpsTyped(checkpoint),
        this.serde.dumpsTyped(metadata),
      ]);
    if (type1 !== type2)
      throw new Error(
        'Failed to serialized checkpoint and metadata to the same type.',
      );
    if (containsInlinePayload(serializedCheckpoint))
      warnStoredPayload(`the checkpoint of thread ${threadId}`);

    const messageRows = await Promise.all(
      messages?.map((message) =>
        this.encodeMessageRow(message, threadId, checkpointNs, checkpoint.id),
      ) ?? [],
    );
    // Metadata stays uncompressed: `list()` filters it SQL-side via
    // `json(CAST(metadata AS TEXT))`. It is small (source/step/parents).
    const storedCheckpoint = await compressForStorage(serializedCheckpoint);

    try {
      await this.db.transaction(async () => {
        await this.db.run(
          `INSERT OR REPLACE INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            threadId,
            checkpointNs,
            checkpoint.id,
            typeof parentCheckpointId === 'string' ? parentCheckpointId : null,
            type1,
            storedCheckpoint,
            serializedMetadata,
          ],
        );
        await this.writeMessageRows(messageRows);
      });
    } catch (err) {
      // Nothing of this write landed: a blob remembered for it must not let
      // a later `put` treat its message as already stored.
      for (const message of messages ?? []) this.encoded.delete(message);
      throw err;
    }

    await this.pruneThread(threadId, checkpointNs);

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  /**
   * Upsert a checkpoint's message rows (in array order). A checkpoint's
   * messages are read back in rowid order (`loadCheckpointMessages`), so
   * rowids must increase along the array. A message whose row exists keeps
   * it — updated in place, which leaves the pages whose bytes did not
   * change untouched — as long as that holds; from the first message that
   * is new or would break the order (a summary placed before the history
   * it kept) on, every row is written with `INSERT OR REPLACE`, which
   * gives it a new rowid after all others, exactly as every row used to be.
   * A kept row whose message is unchanged since it was stored is only
   * re-keyed to this checkpoint, all of them in one statement: its content
   * and blob are not bound again. Inside the caller's transaction.
   */
  private async writeMessageRows(encoded: EncodedMessageRow[]): Promise<void> {
    if (encoded.length === 0) return;
    const ids = encoded.map(({ row }) => row[MESSAGE_ID_COLUMN]);
    const existing = new Map<string, number>();
    for (const row of await this.db.exec<{
      message_id: string;
      rowid: number;
    }>(
      'SELECT m.message_id, m.rowid FROM json_each(?) AS j JOIN messages AS m ON m.message_id = j.value',
      [JSON.stringify(ids)],
    ))
      existing.set(row.message_id, row.rowid);
    let lastRowid = -1;
    let appending = false;
    const rekey: string[] = [];
    let rekeyTo: SqlParam[] | undefined;
    for (const { row, unchanged } of encoded) {
      const id = row[MESSAGE_ID_COLUMN];
      const rowid = typeof id === 'string' ? existing.get(id) : undefined;
      if (!appending && rowid !== undefined && rowid > lastRowid) {
        lastRowid = rowid;
        if (unchanged && typeof id === 'string') {
          rekey.push(id);
          rekeyTo = row;
          continue;
        }
        await this.db.run(
          `INSERT INTO messages (thread_id, checkpoint_ns, checkpoint_id, message_id, message_type, message_content, message, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(message_id) DO UPDATE SET
             thread_id = excluded.thread_id,
             checkpoint_ns = excluded.checkpoint_ns,
             checkpoint_id = excluded.checkpoint_id,
             message_type = excluded.message_type,
             message_content = excluded.message_content,
             message = excluded.message,
             created_at = excluded.created_at`,
          row,
        );
        continue;
      }
      appending = true;
      await this.db.run(
        `INSERT OR REPLACE INTO messages (thread_id, checkpoint_ns, checkpoint_id, message_id, message_type, message_content, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        row,
      );
    }
    if (rekeyTo !== undefined && rekey.length > 0) {
      // Every row of one put shares the checkpoint columns.
      const [threadId, checkpointNs, checkpointId] = rekeyTo;
      await this.db.run(
        `UPDATE messages SET thread_id = ?, checkpoint_ns = ?, checkpoint_id = ?
         WHERE message_id IN (SELECT value FROM json_each(?))`,
        [threadId, checkpointNs, checkpointId, JSON.stringify(rekey)],
      );
    }
  }

  /** Normalize a message's `additional_kwargs` and serialize it exactly as the Node runtime does. */
  private async toMessageRow(
    message: BaseMessage,
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
  ): Promise<SqlParam[]> {
    return (
      await this.encodeMessageRow(message, threadId, checkpointNs, checkpointId)
    ).row;
  }

  /**
   * Normalize a message's `additional_kwargs` (assigned back onto it, the
   * shape every stored row has) and return them.
   */
  private normalizeKwargs(message: BaseMessage): CleanAdditionalKwargs {
    const original = message.additional_kwargs;
    const msgFromMatrixRoom = original.msgFromMatrixRoom === true;
    const cleaned = cleanAdditionalKwargs(
      original,
      msgFromMatrixRoom,
      this.oracleName,
    );
    // Same shape the Node runtime writes: AI messages always carry the two
    // reasoning keys (possibly undefined, which `_default` encodes as an
    // explicit `{ lc: 2, type: 'undefined' }`); other message types never do.
    const merged: CleanAdditionalKwargs = {
      ...cleaned,
      reasoning: cleaned.reasoning ?? asOptionalString(original.reasoning),
      reasoningDetails:
        cleaned.reasoningDetails ??
        asReasoningDetails(original.reasoningDetails),
    };
    if (message.getType() !== 'ai') {
      delete merged.reasoning;
      delete merged.reasoningDetails;
    }
    message.additional_kwargs = merged;
    return merged;
  }

  /**
   * Remember the blob a message was just loaded from, so a `put` that finds
   * it unchanged neither serializes nor compresses it again.
   */
  private rememberLoaded(message: BaseMessage, raw: Uint8Array | string): void {
    if (!(raw instanceof Uint8Array)) return;
    // A row written before attachment bytes were left out of storage still
    // holds them: not remembered, so the next `put` stores its placeholder.
    if (hasInlinePayload(message)) return;
    this.encoded.set(message, {
      fingerprint: fingerprintOf(message, this.normalizeKwargs(message)),
      blob: raw,
    });
  }

  /**
   * A message's row parameters. A message whose fingerprint matches the
   * blob last encoded or loaded for it reuses that blob without
   * serializing it (`unchanged`); any other is serialized and compressed.
   * A human message with inline attachment bytes is stored as its
   * placeholder copy (`offloadInlinePayloads`): the copy is serialized once
   * and dropped, and only its blob and content text are remembered.
   */
  private async encodeMessageRow(
    message: BaseMessage,
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
  ): Promise<EncodedMessageRow> {
    const merged = this.normalizeKwargs(message);
    const fingerprint = fingerprintOf(message, merged);
    let encoded = this.encoded.get(message);
    let unchanged = false;
    if (
      encoded !== undefined &&
      sameFingerprint(encoded.fingerprint, fingerprint)
    ) {
      unchanged = true;
    } else {
      const placeholder = offloadInlinePayloads(message);
      const stored = placeholder ?? message;
      encoded = {
        fingerprint,
        blob: await compressForStorage(
          stringify(stored, (_key, value) => _default(value)),
        ),
        ...(placeholder
          ? { storedContent: contentColumn(placeholder.content) }
          : {}),
      };
      this.encoded.set(message, encoded);
    }
    const messageId =
      message.id ??
      (typeof message.lc_kwargs.id === 'string'
        ? message.lc_kwargs.id
        : undefined);
    if (messageId === undefined) throw new Error('message is missing an id');
    return {
      row: [
        threadId,
        checkpointNs,
        checkpointId,
        messageId,
        message.getType(),
        encoded.storedContent ?? contentColumn(message.content),
        encoded.blob,
        merged.timestamp,
      ],
      unchanged,
    };
  }

  /**
   * Drop checkpoints (and their writes) beyond the newest
   * `maxCheckpointsPerThread` for a thread. `messages` is left intact — it is
   * the user-visible transcript.
   */
  protected async pruneThread(
    threadId: string,
    checkpointNs: string,
  ): Promise<void> {
    const keep = this.maxCheckpointsPerThread;
    if (keep <= 0) return;
    const row = await this.db.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ?',
      [threadId, checkpointNs],
    );
    if (row === undefined || row.count <= keep + PRUNE_SLACK) return;
    const survivors = `SELECT checkpoint_id FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? ORDER BY checkpoint_id DESC LIMIT ?`;
    const args = [threadId, checkpointNs, threadId, checkpointNs, keep];
    await this.db.transaction(async () => {
      await this.db.run(
        `DELETE FROM writes WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id NOT IN (${survivors})`,
        args,
      );
      await this.db.run(
        `DELETE FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id NOT IN (${survivors})`,
        args,
      );
    });
    // Hand freed pages back; no-op on files whose auto_vacuum is still NONE.
    await this.db.run('PRAGMA incremental_vacuum');
  }

  /**
   * Store a task's writes on a checkpoint, with the serialized path of the
   * task (`taskPath`, `''` when the graph gives none: input and `Command`
   * writes) that orders them on read (`loadPendingWrites`).
   */
  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath?: string,
  ): Promise<void> {
    await this.setup();
    if (!config.configurable) throw new Error('Empty configuration supplied.');
    const configurable = config.configurable;
    const givenThreadId: unknown = configurable.thread_id;
    const checkpointId: unknown = configurable.checkpoint_id;
    let resolvedThreadId: string;
    if (typeof givenThreadId === 'string' && givenThreadId.length > 0) {
      resolvedThreadId = givenThreadId;
    } else {
      console.error(
        '[sqlite-saver] missing thread_id field in config.configurable',
        configurable,
      );
      const found =
        typeof checkpointId === 'string'
          ? await this.db.get<{ thread_id: string }>(
              'SELECT thread_id FROM checkpoints WHERE checkpoint_id = ?',
              [checkpointId],
            )
          : undefined;
      if (found === undefined) {
        throw new Error(
          'Missing thread_id field in config.configurable. config: ' +
            JSON.stringify(configurable),
        );
      }
      resolvedThreadId = found.thread_id;
      configurable.thread_id = found.thread_id;
    }
    if (typeof checkpointId !== 'string' || checkpointId.length === 0) {
      console.error(
        '[sqlite-saver] missing checkpoint_id field in config.configurable',
        configurable,
      );
      throw new Error(
        'Missing checkpoint_id field in config.configurable. config: ' +
          JSON.stringify(configurable),
      );
    }
    const checkpointNs: unknown = configurable.checkpoint_ns;
    const ns = typeof checkpointNs === 'string' ? checkpointNs : '';

    const holding: string[] = [];
    const rows = await Promise.all(
      writes.map(async (write, idx): Promise<SqlParam[]> => {
        const [type, serialized] = await this.serde.dumpsTyped(
          withoutInlinePayloads(write[1]),
        );
        if (containsInlinePayload(serialized)) holding.push(write[0]);
        return [
          resolvedThreadId,
          ns,
          checkpointId,
          taskId,
          idx,
          write[0],
          type,
          await compressForStorage(serialized),
          taskPath ?? '',
        ];
      }),
    );
    if (holding.length > 0)
      warnStoredPayload(
        `a pending write of thread ${resolvedThreadId} (task ${taskId}, channel ${holding.join(', ')})`,
      );
    await this.db.transaction(async () => {
      for (const row of rows) {
        await this.db.run(
          `INSERT OR REPLACE INTO writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value, task_path)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          row,
        );
      }
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.setup();
    this.sweptThreads.delete(threadId);
    await this.db.transaction(async () => {
      await this.db.run(
        'DELETE FROM attachment_payload_sweeps WHERE thread_id = ?',
        [threadId],
      );
      await this.db.run('DELETE FROM checkpoints WHERE thread_id = ?', [
        threadId,
      ]);
      await this.db.run('DELETE FROM writes WHERE thread_id = ?', [threadId]);
      await this.db.run('DELETE FROM messages WHERE thread_id = ?', [threadId]);
    });
  }

  /** Attach the parent's `TASKS` writes as `pending_sends` on a pre-v4 checkpoint. */
  protected async migratePendingSends(
    checkpoint: Checkpoint,
    threadId: string,
    parentCheckpointId: string,
  ): Promise<void> {
    const row = await this.db.get<{ pending_sends: string }>(
      `SELECT json_group_array(json_object('type', ps.type, 'value', hex(ps.value))) AS pending_sends
       FROM writes AS ps
       WHERE ps.thread_id = ? AND ps.checkpoint_id = ? AND ps.channel = '${TASKS}'
       ORDER BY ps.idx`,
      [threadId, parentCheckpointId],
    );
    const pendingSends = JSON.parse(
      row?.pending_sends ?? '[]',
    ) as PendingSendColumn[];
    checkpoint.channel_values ??= {};
    checkpoint.channel_values[TASKS] = await Promise.all(
      pendingSends.map(async ({ type, value }) =>
        this.serde.loadsTyped(type, await hexColumnText(value)),
      ),
    );
    checkpoint.channel_versions[TASKS] =
      Object.keys(checkpoint.channel_versions).length > 0
        ? maxChannelVersion(...Object.values(checkpoint.channel_versions))
        : this.getNextVersion(undefined);
  }
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asReasoningDetails(
  value: unknown,
): Array<{ type: string; text: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (d): d is { type: string; text: string } =>
      typeof d === 'object' &&
      d !== null &&
      typeof d.type === 'string' &&
      typeof d.text === 'string',
  );
}

/**
 * One line for a write that stores inline base64 after stripping
 * (`containsInlinePayload`): a tool or AI message carrying base64, or a
 * human message in a shape `withoutInlinePayloads` does not reach.
 */
function warnStoredPayload(what: string): void {
  console.warn(
    `[sqlite-saver] ${what} still holds inline base64 after attachment stripping: a tool/AI message with base64 content, or a message shape inline-payloads.ts does not reach; those bytes are stored`,
  );
}

/** The `messages.message_content` text of a message's content. */
function contentColumn(content: BaseMessage['content']): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

function isCheckpointWithMessages(
  checkpoint: Checkpoint,
): checkpoint is CheckpointWithMessages {
  return 'messages' in checkpoint.channel_values;
}

/**
 * The checkpoint as its blob stores it: `channel_values.messages` taken out
 * (they become message rows, returned) and inline attachment bytes left out
 * of every other channel value. The input is never modified; it is returned
 * as is when there is nothing to take out.
 */
function toStoredCheckpoint(checkpoint: Checkpoint): {
  checkpoint: Checkpoint;
  messages?: BaseMessage[];
} {
  const messages = isCheckpointWithMessages(checkpoint)
    ? checkpoint.channel_values.messages
    : undefined;
  let channelValues: ChannelValues | undefined;
  for (const [channel, value] of Object.entries(checkpoint.channel_values)) {
    if (channel === 'messages') continue;
    const stored = withoutInlinePayloads(value);
    if (stored === value) continue;
    channelValues ??= { ...checkpoint.channel_values };
    channelValues[channel] = stored;
  }
  if (messages === undefined && channelValues === undefined)
    return { checkpoint };
  const copy = copyCheckpoint(checkpoint);
  if (channelValues !== undefined) copy.channel_values = channelValues;
  delete copy.channel_values.messages;
  return { checkpoint: copy, ...(messages ? { messages } : {}) };
}

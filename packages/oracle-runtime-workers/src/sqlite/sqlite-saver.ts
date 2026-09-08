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
 *          type, value BLOB)
 *   messages(thread_id, checkpoint_ns, checkpoint_id, message_id PK,
 *            message_type, message_content, message BLOB, created_at)
 *   schema_migrations(version PK, name, applied_at)
 *
 * Behaviour kept from the original:
 * - `channel_values.messages` is stripped from the stored checkpoint and each
 *   message is upserted into `messages` (keyed by message id, so the table is
 *   the full transcript: rows survive checkpoint pruning and summarization).
 * - `put` prunes a thread to `maxCheckpointsPerThread` newest checkpoints (and
 *   their writes) once it exceeds the cap by `PRUNE_SLACK`.
 * - `pending_sends` migration for pre-v4 checkpoints.
 * - Serialization is `JsonPlusSerializer` (the `BaseCheckpointSaver` default).
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
  copyCheckpoint,
  maxChannelVersion,
  type PendingWrite,
  type SerializerProtocol,
  TASKS,
} from '@langchain/langgraph-checkpoint';
import { compressForStorage, hexToBytes, readBlobText } from './blob-codec';
import type { DoSqliteDatabase, SqlParam } from './database';
import {
  _default,
  cleanAdditionalKwargs,
  stringify,
  type CleanAdditionalKwargs,
} from './serialization';

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

type CheckpointRow = {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  type: string | null;
  checkpoint: Uint8Array | string;
  metadata: Uint8Array | string;
  pending_writes: string;
  pending_sends: string;
};

type MessageRow = {
  message: Uint8Array | string;
};

interface PendingWriteColumn {
  task_id: string;
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
const checkpointMetadataKeys = ['source', 'step', 'parents'] as const;
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

const MIGRATIONS: readonly Migration[] = [migration001];

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
        json_object('task_id', pw.task_id, 'channel', pw.channel, 'type', pw.type, 'value', hex(pw.value))
      )
      FROM writes AS pw
      WHERE pw.thread_id = checkpoints.thread_id
        AND pw.checkpoint_ns = checkpoints.checkpoint_ns
        AND pw.checkpoint_id = checkpoints.checkpoint_id
    ) AS pending_writes,
    (
      SELECT json_group_array(json_object('type', ps.type, 'value', hex(ps.value)))
      FROM writes AS ps
      WHERE ps.thread_id = checkpoints.thread_id
        AND ps.checkpoint_ns = checkpoints.checkpoint_ns
        AND ps.checkpoint_id = checkpoints.parent_checkpoint_id
        AND ps.channel = '${TASKS}'
      ORDER BY ps.idx
    ) AS pending_sends
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
      `CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id)`,
    );
    await db.run(
      `CREATE INDEX IF NOT EXISTS idx_messages_checkpoint_id ON messages(checkpoint_id)`,
    );
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
    const rows = await this.db.exec<MessageRow>(
      'SELECT message FROM messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC',
      [threadId],
    );
    return Promise.all(rows.map((row) => this.loadMessage(row.message)));
  }

  /**
   * The thread's messages whose stored plain content (`message_content`)
   * contains `contentContains`, oldest first — a SQL `LIKE` pre-filter, so
   * only the matching rows' blobs are inflated. Attachment payload retention
   * uses it to find rows that still hold inline bytes / a placeholder.
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
   * Rewrite one persisted message in place — same row, checkpoint linkage
   * and `created_at` (transcript order) untouched. Returns false when the
   * thread has no row for the message's id. Attachment payload retention
   * uses it to swap inline bytes for a placeholder after a turn.
   */
  async replaceThreadMessage(
    threadId: string,
    message: BaseMessage,
  ): Promise<boolean> {
    await this.setup();
    // Only the type/content/blob columns of the row are taken from the
    // encoder; the checkpoint columns it also produces stay as stored.
    const [, , , messageId, messageType, messageContent, blob] =
      await this.toMessageRow(message, threadId, '', '');
    const result = await this.db.run(
      'UPDATE messages SET message_type = ?, message_content = ?, message = ? WHERE thread_id = ? AND message_id = ?',
      [messageType!, messageContent!, blob!, threadId, messageId!],
    );
    return result.changes > 0;
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

  private async loadPendingWrites(
    json: string,
  ): Promise<Array<[string, string, unknown]>> {
    const columns = JSON.parse(json) as PendingWriteColumn[];
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
    const rows = await this.db.exec<MessageRow>(
      'SELECT message FROM messages WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?',
      [threadId, checkpointNs, checkpointId],
    );
    return Promise.all(rows.map((row) => this.loadMessage(row.message)));
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

    const { checkpoint, messages } = removeMessagesFromCheckpoint(checkpointIn);
    const [[type1, serializedCheckpoint], [type2, serializedMetadata]] =
      await Promise.all([
        this.serde.dumpsTyped(checkpoint),
        this.serde.dumpsTyped(metadata),
      ]);
    if (type1 !== type2)
      throw new Error(
        'Failed to serialized checkpoint and metadata to the same type.',
      );

    const messageRows = await Promise.all(
      messages?.map((message) =>
        this.toMessageRow(message, threadId, checkpointNs, checkpoint.id),
      ) ?? [],
    );
    // Metadata stays uncompressed: `list()` filters it SQL-side via
    // `json(CAST(metadata AS TEXT))`. It is small (source/step/parents).
    const storedCheckpoint = await compressForStorage(serializedCheckpoint);

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
      for (const row of messageRows) {
        await this.db.run(
          `INSERT OR REPLACE INTO messages (thread_id, checkpoint_ns, checkpoint_id, message_id, message_type, message_content, message, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          row,
        );
      }
    });

    await this.pruneThread(threadId, checkpointNs);

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  /** Normalize a message's `additional_kwargs` and serialize it exactly as the Node runtime does. */
  private async toMessageRow(
    message: BaseMessage,
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
  ): Promise<SqlParam[]> {
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

    const serialized = await compressForStorage(
      stringify(message, (_key, value) => _default(value)),
    );
    const messageId =
      message.id ??
      (typeof message.lc_kwargs.id === 'string'
        ? message.lc_kwargs.id
        : undefined);
    if (messageId === undefined) throw new Error('message is missing an id');
    return [
      threadId,
      checkpointNs,
      checkpointId,
      messageId,
      message.getType(),
      typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content),
      serialized,
      merged.timestamp,
    ];
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

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
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

    const rows = await Promise.all(
      writes.map(async (write, idx): Promise<SqlParam[]> => {
        const [type, serialized] = await this.serde.dumpsTyped(write[1]);
        return [
          resolvedThreadId,
          ns,
          checkpointId,
          taskId,
          idx,
          write[0],
          type,
          await compressForStorage(serialized),
        ];
      }),
    );
    await this.db.transaction(async () => {
      for (const row of rows) {
        await this.db.run(
          `INSERT OR REPLACE INTO writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          row,
        );
      }
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.setup();
    await this.db.transaction(async () => {
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

function isCheckpointWithMessages(
  checkpoint: Checkpoint,
): checkpoint is CheckpointWithMessages {
  return 'messages' in checkpoint.channel_values;
}

function removeMessagesFromCheckpoint(checkpoint: Checkpoint): {
  checkpoint: Checkpoint;
  messages?: BaseMessage[];
} {
  if (!isCheckpointWithMessages(checkpoint)) return { checkpoint };
  const copy = copyCheckpoint(checkpoint);
  delete copy.channel_values.messages;
  return { checkpoint: copy, messages: checkpoint.channel_values.messages };
}

import { Logger } from '@ixo/logger';
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
import Database, {
  type Database as DatabaseType,
  type Statement,
} from 'better-sqlite3';
import { type BaseMessage } from 'langchain';
import migration001 from './migrations/001_add_created_at_to_messages';
import {
  _default,
  type CleanAdditionalKwargs,
  cleanAdditionalKwargs,
  stringify,
} from './utils';

type ChannelValues<C extends string = string> = {
  [key in C]: unknown;
};

interface CheckpointWithMessages<
  N extends string = string,
  C extends string = string,
> extends Checkpoint<N, C> {
  channel_values: ChannelValues<C> & {
    messages?: BaseMessage[];
  };
}

interface MessageRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  message_id: string;
  message_type: string;
  message_content: string;
  message: string;
  created_at: string;
}

interface CheckpointRow {
  checkpoint: string;
  metadata: string;
  parent_checkpoint_id?: string;
  thread_id: string;
  checkpoint_id: string;
  checkpoint_ns?: string;
  type?: string;
  pending_writes: string;
}

interface PendingWriteColumn {
  task_id: string;
  channel: string;
  type: string;
  value: string;
}

interface PendingSendColumn {
  type: string;
  value: string;
}

interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseType) => void;
}

// In the `SqliteSaver.list` method, we need to sanitize the `options.filter` argument to ensure it only contains keys
// that are part of the `CheckpointMetadata` type. The lines below ensure that we get compile-time errors if the list
// of keys that we use is out of sync with the `CheckpointMetadata` type.
const checkpointMetadataKeys = ['source', 'step', 'parents'] as const;

type CheckKeys<T, K extends readonly (keyof T)[]> = [K[number]] extends [
  keyof T,
]
  ? [keyof T] extends [K[number]]
    ? K
    : never
  : never;

function validateKeys<T, K extends readonly (keyof T)[]>(
  keys: CheckKeys<T, K>,
): K {
  return keys;
}

// If this line fails to compile, the list of keys that we use in the `SqliteSaver.list` method is out of sync with the
// `CheckpointMetadata` type. In that case, just update `checkpointMetadataKeys` to contain all the keys in
// `CheckpointMetadata`
const validCheckpointMetadataKeys = validateKeys<
  CheckpointMetadata,
  typeof checkpointMetadataKeys
>(checkpointMetadataKeys);

function prepareSql(db: DatabaseType, checkpointId: boolean) {
  const sql = `
  SELECT
    thread_id,
    checkpoint_ns,
    checkpoint_id,
    parent_checkpoint_id,
    type,
    checkpoint,
    metadata,
    (
      SELECT
        json_group_array(
          json_object(
            'task_id', pw.task_id,
            'channel', pw.channel,
            'type', pw.type,
            'value', CAST(pw.value AS TEXT)
          )
        )
      FROM writes as pw
      WHERE pw.thread_id = checkpoints.thread_id
        AND pw.checkpoint_ns = checkpoints.checkpoint_ns
        AND pw.checkpoint_id = checkpoints.checkpoint_id
    ) as pending_writes,
    (
      SELECT
        json_group_array(
          json_object(
            'type', ps.type,
            'value', CAST(ps.value AS TEXT)
          )
        )
      FROM writes as ps
      WHERE ps.thread_id = checkpoints.thread_id
        AND ps.checkpoint_ns = checkpoints.checkpoint_ns
        AND ps.checkpoint_id = checkpoints.parent_checkpoint_id
        AND ps.channel = '${TASKS}'
      ORDER BY ps.idx
    ) as pending_sends
  FROM checkpoints
  WHERE thread_id = ? AND checkpoint_ns = ? ${
    checkpointId
      ? 'AND checkpoint_id = ?'
      : 'ORDER BY checkpoint_id DESC LIMIT 1'
  }`;

  return db.prepare(sql);
}

export class SqliteSaver extends BaseCheckpointSaver {
  db: DatabaseType;

  protected isSetup: boolean;

  protected withoutCheckpoint: Statement;

  protected withCheckpoint: Statement;

  protected putCheckpointStmt: Statement;

  protected putWritesStmt: Statement;

  protected deleteCheckpointsStmt: Statement;
  protected putMessageStmt: Statement;

  protected getMessageStmt: Statement;

  protected deleteWritesStmt: Statement;

  protected deleteMessagesStmt: Statement;

  constructor(db: DatabaseType, serde?: SerializerProtocol) {
    super(serde);
    this.db = db;
    this.isSetup = false;
  }

  static fromConnString(connStringOrLocalPath: string): SqliteSaver {
    return new SqliteSaver(new Database(connStringOrLocalPath));
  }

  static fromDatabase(
    db: DatabaseType,
    serde?: SerializerProtocol,
  ): SqliteSaver {
    return new SqliteSaver(db, serde);
  }

  close(): void {
    if (this.db.open) {
      this.db.close();
    }
  }

  /**
   * Create schema_migrations table to track applied migrations
   */
  protected createSchemaMigrationsTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER NOT NULL PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  /**
   * Get list of applied migration versions
   */
  protected getAppliedMigrations(): number[] {
    try {
      const rows = this.db
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all() as Array<{ version: number }>;
      return rows.map((row) => row.version);
    } catch {
      // Table doesn't exist yet, return empty array
      return [];
    }
  }

  /**
   * Record that a migration has been applied
   */
  protected recordMigration(migration: Migration): void {
    this.db
      .prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
      )
      .run(migration.version, migration.name);
  }

  /**
   * Load all migration files from the migrations folder
   *
   * Note: When adding new migrations:
   * 1. Import them at the top of this file
   * 2. Add them to the migrations array below
   */
  protected loadMigrations(): Migration[] {
    const migrations: Migration[] = [
      migration001,
      // Add future migrations here:
      // migration002,
      // migration003,
    ];

    // Sort by version to ensure correct order
    migrations.sort((a, b) => a.version - b.version);

    return migrations;
  }

  /**
   * Run pending migrations
   */
  protected runMigrations(): void {
    this.createSchemaMigrationsTable();

    const appliedVersions = this.getAppliedMigrations();
    const allMigrations = this.loadMigrations();

    const pendingMigrations = allMigrations.filter(
      (migration) => !appliedVersions.includes(migration.version),
    );

    if (pendingMigrations.length === 0) {
      return;
    }

    Logger.info(`Running ${pendingMigrations.length} pending migration(s)...`);

    for (const migration of pendingMigrations) {
      try {
        Logger.info(
          `Applying migration ${migration.version}: ${migration.name}`,
        );
        migration.up(this.db);
        this.recordMigration(migration);
        Logger.info(
          `Migration ${migration.version}: ${migration.name} applied successfully`,
        );
      } catch (error) {
        Logger.error(
          `Failed to apply migration ${migration.version}: ${migration.name}`,
          error,
        );
        throw error;
      }
    }
  }

  protected setup(): void {
    if (this.isSetup) {
      return;
    }

    // Set busy timeout for concurrent access
    this.db.pragma('busy_timeout = 5000');

    // Create base tables
    this.db.exec(`
CREATE TABLE IF NOT EXISTS checkpoints (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT,
  type TEXT,
  checkpoint BLOB,
  metadata BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);`);
    this.db.exec(`
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
);`);

    // Create messages table
    // For new databases, created_at is included
    // For existing databases, the migration will add it if missing
    this.db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  message_type TEXT NOT NULL,
  message_content TEXT NOT NULL,
  message BLOB,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY  (message_id)
    );
`);

    // Create schema_migrations table and run migrations
    this.runMigrations();

    // Create indexes (after migrations have run)
    this.db.exec(`
CREATE INDEX IF NOT EXISTS idx_messages_thread_id 
ON messages(thread_id);
`);
    this.db.exec(`
CREATE INDEX IF NOT EXISTS idx_messages_checkpoint_id 
ON messages(checkpoint_id);
`);

    this.db.exec(`
CREATE INDEX IF NOT EXISTS idx_messages_lookup 
ON messages(thread_id, checkpoint_ns, checkpoint_id);
`);

    // Create index on created_at (migration ensures column exists)
    this.db.exec(`
CREATE INDEX IF NOT EXISTS idx_messages_thread_created 
ON messages(thread_id, created_at);
`);

    this.db.exec(`
CREATE INDEX IF NOT EXISTS idx_writes_channel 
ON writes(thread_id, checkpoint_id, channel);
`);

    this.withoutCheckpoint = prepareSql(this.db, false);
    this.withCheckpoint = prepareSql(this.db, true);

    // Cache prepared statements for write operations
    this.putCheckpointStmt = this.db.prepare(
      `INSERT OR REPLACE INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.putWritesStmt = this.db.prepare(`
      INSERT OR REPLACE INTO writes 
      (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.deleteCheckpointsStmt = this.db.prepare(
      `DELETE FROM checkpoints WHERE thread_id = ?`,
    );
    this.deleteWritesStmt = this.db.prepare(
      `DELETE FROM writes WHERE thread_id = ?`,
    );

    this.putMessageStmt = this.db.prepare(
      `INSERT OR REPLACE INTO messages (thread_id, checkpoint_ns, checkpoint_id, message_id, message_type, message_content, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.getMessageStmt = this.db.prepare(
      `SELECT * FROM messages WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`,
    );

    this.deleteMessagesStmt = this.db.prepare(
      `DELETE FROM messages WHERE thread_id = ?`,
    );

    this.isSetup = true;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    return this.loadTuple(config, true);
  }

  /**
   * Like `getTuple` but skips the `messages` join and its per-message
   * deserialization. For callers that only need the checkpoint's scalar
   * `channel_values` (e.g. building the agent from `loadedPlugins` /
   * `currentEntityDid`) and never read the history — the returned checkpoint's
   * `channel_values.messages` is left unset. O(1) in conversation length
   * instead of O(history).
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
    this.setup();
    const {
      thread_id,
      checkpoint_ns = '',
      checkpoint_id,
    } = config.configurable ?? {};

    const args = [thread_id, checkpoint_ns];
    if (checkpoint_id) args.push(checkpoint_id);

    const stm = checkpoint_id ? this.withCheckpoint : this.withoutCheckpoint;
    const row = stm.get(...args) as CheckpointRow;
    if (row === undefined) return undefined;

    let finalConfig = config;

    if (!checkpoint_id) {
      finalConfig = {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns,
          checkpoint_id: row.checkpoint_id,
        },
      };
    }

    if (
      finalConfig.configurable?.thread_id === undefined ||
      finalConfig.configurable?.checkpoint_id === undefined
    ) {
      throw new Error('Missing thread_id or checkpoint_id');
    }

    const messages = includeMessages
      ? (this.getMessageStmt.all(
          finalConfig.configurable?.thread_id,
          finalConfig.configurable?.checkpoint_ns,
          finalConfig.configurable?.checkpoint_id,
        ) as MessageRow[])
      : [];

    const pendingWrites = await Promise.all(
      (JSON.parse(row.pending_writes) as PendingWriteColumn[]).map(
        async (write) => {
          return [
            write.task_id,
            write.channel,
            await this.serde.loadsTyped(
              write.type ?? 'json',
              write.value ?? '',
            ),
          ] as [string, string, unknown];
        },
      ),
    );

    const parsedMessages: BaseMessage[] = await Promise.all(
      messages.map(async (message) => {
        return this.serde.loadsTyped('json', message.message);
      }),
    );

    const checkpoint = (await this.serde.loadsTyped(
      row.type ?? 'json',
      row.checkpoint,
    )) as Checkpoint;

    if (parsedMessages.length > 0) {
      checkpoint.channel_values.messages = parsedMessages;
    }

    if (checkpoint.v < 4 && row.parent_checkpoint_id != null) {
      await this.migratePendingSends(
        checkpoint,
        row.thread_id,
        row.parent_checkpoint_id,
      );
    }

    return {
      checkpoint,
      config: finalConfig,
      metadata: (await this.serde.loadsTyped(
        row.type ?? 'json',
        row.metadata,
      )) as CheckpointMetadata,
      parentConfig: row.parent_checkpoint_id
        ? {
            configurable: {
              thread_id: row.thread_id,
              checkpoint_ns,
              checkpoint_id: row.parent_checkpoint_id,
            },
          }
        : undefined,
      pendingWrites,
    };
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const { limit, before, filter } = options ?? {};
    this.setup();
    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns;
    let sql = `
      SELECT
        thread_id,
        checkpoint_ns,
        checkpoint_id,
        parent_checkpoint_id,
        type,
        checkpoint,
        metadata,
        (
          SELECT
            json_group_array(
              json_object(
                'task_id', pw.task_id,
                'channel', pw.channel,
                'type', pw.type,
                'value', CAST(pw.value AS TEXT)
              )
            )
          FROM writes as pw
          WHERE pw.thread_id = checkpoints.thread_id
            AND pw.checkpoint_ns = checkpoints.checkpoint_ns
            AND pw.checkpoint_id = checkpoints.checkpoint_id
        ) as pending_writes,
        (
          SELECT
            json_group_array(
              json_object(
                'type', ps.type,
                'value', CAST(ps.value AS TEXT)
              )
            )
          FROM writes as ps
          WHERE ps.thread_id = checkpoints.thread_id
            AND ps.checkpoint_ns = checkpoints.checkpoint_ns
            AND ps.checkpoint_id = checkpoints.parent_checkpoint_id
            AND ps.channel = '${TASKS}'
          ORDER BY ps.idx
        ) as pending_sends
      FROM checkpoints\n`;

    const whereClause: string[] = [];

    if (thread_id) {
      whereClause.push('thread_id = ?');
    }

    if (checkpoint_ns !== undefined && checkpoint_ns !== null) {
      whereClause.push('checkpoint_ns = ?');
    }

    if (before?.configurable?.checkpoint_id !== undefined) {
      whereClause.push('checkpoint_id < ?');
    }

    const sanitizedFilter = Object.fromEntries(
      Object.entries(filter ?? {}).filter(
        ([key, value]) =>
          value !== undefined &&
          validCheckpointMetadataKeys.includes(key as keyof CheckpointMetadata),
      ),
    );

    whereClause.push(
      ...Object.entries(sanitizedFilter).map(
        ([key]) => `jsonb(CAST(metadata AS TEXT))->'$.${key}' = ?`,
      ),
    );

    if (whereClause.length > 0) {
      sql += `WHERE\n  ${whereClause.join(' AND\n  ')}\n`;
    }

    sql += '\nORDER BY checkpoint_id DESC';

    if (limit) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sql += ` LIMIT ${parseInt(limit as any, 10)}`; // parseInt here (with cast to make TS happy) to sanitize input, as limit may be user-provided
    }

    const args = [
      thread_id,
      checkpoint_ns,
      before?.configurable?.checkpoint_id,
      ...Object.values(sanitizedFilter).map((value) => JSON.stringify(value)),
    ].filter((value) => value !== undefined && value !== null);

    const rows: CheckpointRow[] = this.db
      .prepare(sql)
      .all(...args) as CheckpointRow[];

    if (rows) {
      for (const row of rows) {
        const pendingWrites = await Promise.all(
          (JSON.parse(row.pending_writes) as PendingWriteColumn[]).map(
            async (write) => {
              return [
                write.task_id,
                write.channel,
                await this.serde.loadsTyped(
                  write.type ?? 'json',
                  write.value ?? '',
                ),
              ] as [string, string, unknown];
            },
          ),
        );

        const messages = this.getMessageStmt.all(
          row.thread_id,
          row.checkpoint_ns,
          row.checkpoint_id,
        ) as MessageRow[];
        const parsedMessages: BaseMessage[] = await Promise.all(
          messages.map(async (message) => {
            return this.serde.loadsTyped('json', message.message);
          }),
        );

        const checkpoint = (await this.serde.loadsTyped(
          row.type ?? 'json',
          row.checkpoint,
        )) as Checkpoint;

        if (parsedMessages.length > 0) {
          checkpoint.channel_values.messages = parsedMessages;
        }

        if (checkpoint.v < 4 && row.parent_checkpoint_id != null) {
          await this.migratePendingSends(
            checkpoint,
            row.thread_id,
            row.parent_checkpoint_id,
          );
        }

        yield {
          config: {
            configurable: {
              thread_id: row.thread_id,
              checkpoint_ns: row.checkpoint_ns,
              checkpoint_id: row.checkpoint_id,
            },
          },
          checkpoint,
          metadata: (await this.serde.loadsTyped(
            row.type ?? 'json',
            row.metadata,
          )) as CheckpointMetadata,
          parentConfig: row.parent_checkpoint_id
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
    }
  }

  async put(
    config: RunnableConfig,
    _checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    this.setup();

    if (!config.configurable) {
      throw new Error('Empty configuration supplied.');
    }

    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns ?? '';
    const parent_checkpoint_id = config.configurable?.checkpoint_id;

    if (!thread_id) {
      throw new Error(
        `Missing "thread_id" field in passed "config.configurable".`,
      );
    }

    const { checkpoint, messages } = removeMessagesFromCheckpoint(_checkpoint);

    const [[type1, serializedCheckpoint], [type2, serializedMetadata]] =
      await Promise.all([
        this.serde.dumpsTyped(checkpoint),
        this.serde.dumpsTyped(metadata),
      ]);

    if (type1 !== type2) {
      throw new Error(
        'Failed to serialized checkpoint and metadata to the same type.',
      );
    }
    const row = [
      thread_id,
      checkpoint_ns,
      checkpoint.id,
      parent_checkpoint_id,
      type1,
      serializedCheckpoint,
      serializedMetadata,
    ];

    const transaction = this.db.transaction(() => {
      this.putCheckpointStmt.run(...row);
      if (messages) {
        for (const message of messages) {
          const encoder = new TextEncoder();
          const msgFromMatrixRoom = message.additional_kwargs
            .msgFromMatrixRoom as boolean;
          const _additionalKwargs = message.additional_kwargs;
          const cleanedAdditionalKwargs = cleanAdditionalKwargs(
            message.additional_kwargs,
            msgFromMatrixRoom ?? false,
          );

          message.additional_kwargs = {
            ...cleanedAdditionalKwargs,
            reasoning:
              cleanedAdditionalKwargs.reasoning ?? _additionalKwargs.reasoning,
            reasoningDetails:
              cleanedAdditionalKwargs.reasoningDetails ??
              _additionalKwargs.reasoningDetails,
          };

          if (message.type !== 'ai') {
            delete message.additional_kwargs.reasoning;
            delete message.additional_kwargs.reasoningDetails;
          }

          const serializedMessage = encoder.encode(
            stringify(message, (_: string, value: unknown) => {
              return _default(value);
            }),
          );

          const messageRow: MessageRow = {
            thread_id,
            checkpoint_ns,
            checkpoint_id: checkpoint.id,
            message_id: message.id ?? message.lc_kwargs?.id,
            message_type: message.type,
            message_content: message.content.toString(),
            message: serializedMessage as unknown as string,
            created_at:
              (message.additional_kwargs as CleanAdditionalKwargs)?.timestamp ??
              new Date().toISOString(),
          };

          this.putMessageStmt.run(
            messageRow.thread_id,
            messageRow.checkpoint_ns,
            messageRow.checkpoint_id,
            messageRow.message_id,
            messageRow.message_type,
            messageRow.message_content,
            messageRow.message,
            messageRow.created_at,
          );
        }
      }
    });
    transaction();

    return {
      configurable: {
        thread_id,
        checkpoint_ns,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    this.setup();

    if (!config.configurable) {
      throw new Error('Empty configuration supplied.');
    }

    if (!config.configurable?.thread_id) {
      Logger.error('Missing thread_id field in config.configurable.', {
        configurable: config.configurable,
      });

      // get thread id using the checkpoint_id
      const threadId = this.db
        .prepare('SELECT thread_id FROM checkpoints WHERE checkpoint_id = ?')
        .get(config.configurable?.checkpoint_id) as
        | { thread_id: string }
        | undefined;
      if (!threadId) {
        throw new Error(
          'Missing thread_id field in config.configurable. config: ' +
            JSON.stringify(config.configurable),
        );
      }
      config.configurable.thread_id = threadId.thread_id;
    }

    if (!config.configurable?.checkpoint_id) {
      Logger.error('Missing checkpoint_id field in config.configurable.', {
        configurable: config.configurable,
      });
      throw new Error(
        'Missing checkpoint_id field in config.configurable. config: ' +
          JSON.stringify(config.configurable),
      );
    }

    const transaction = this.db.transaction((rows) => {
      for (const row of rows) {
        this.putWritesStmt.run(...row);
      }
    });

    const rows = await Promise.all(
      writes.map(async (write, idx) => {
        const [type, serializedWrite] = await this.serde.dumpsTyped(write[1]);
        return [
          config.configurable?.thread_id,
          config.configurable?.checkpoint_ns,
          config.configurable?.checkpoint_id,
          taskId,
          idx,
          write[0],
          type,
          serializedWrite,
        ];
      }),
    );

    transaction(rows);
  }

  async deleteThread(threadId: string) {
    this.setup();
    const transaction = this.db.transaction(() => {
      this.deleteCheckpointsStmt.run(threadId);
      this.deleteWritesStmt.run(threadId);
      this.deleteMessagesStmt.run(threadId);
    });

    transaction();
  }

  protected async migratePendingSends(
    checkpoint: Checkpoint,
    threadId: string,
    parentCheckpointId: string,
  ) {
    const { pending_sends } = this.db
      .prepare(
        `
          SELECT
            checkpoint_id,
            json_group_array(
              json_object(
                'type', ps.type,
                'value', CAST(ps.value AS TEXT)
              )
            ) as pending_sends
          FROM writes as ps
          WHERE ps.thread_id = ?
            AND ps.checkpoint_id = ?
            AND ps.channel = '${TASKS}'
          ORDER BY ps.idx
        `,
      )
      .get(threadId, parentCheckpointId) as { pending_sends: string };

    const mutableCheckpoint = checkpoint;

    // add pending sends to checkpoint
    mutableCheckpoint.channel_values ??= {};
    mutableCheckpoint.channel_values[TASKS] = await Promise.all(
      JSON.parse(pending_sends).map(({ type, value }: PendingSendColumn) =>
        this.serde.loadsTyped(type, value),
      ),
    );

    // add to versions
    mutableCheckpoint.channel_versions[TASKS] =
      Object.keys(checkpoint.channel_versions).length > 0
        ? maxChannelVersion(...Object.values(checkpoint.channel_versions))
        : this.getNextVersion(undefined);
  }
}

const isCheckpointWithMessages = (
  checkpoint: Checkpoint,
): checkpoint is CheckpointWithMessages => {
  return 'messages' in checkpoint.channel_values;
};

const removeMessagesFromCheckpoint = (
  checkpoint: Checkpoint,
): {
  checkpoint: Checkpoint;
  messages?: BaseMessage[];
} => {
  if (isCheckpointWithMessages(checkpoint)) {
    const newCheckpoint = copyCheckpoint(checkpoint);
    delete newCheckpoint.channel_values.messages;
    return {
      checkpoint: newCheckpoint,
      messages: checkpoint.channel_values.messages,
    };
  }
  return {
    checkpoint,
    messages: undefined,
  };
};

/**
 * Test-only Durable Object exercising the SQLite layer inside workerd. Bound
 * as `SQLITE_TEST` by `test/wrangler.test.jsonc`. Every method is callable
 * over DO RPC (`stub.method(...)`); `fetch()` exposes the same operations as
 * JSON for HTTP-style drivers.
 *
 * Not part of the runtime — it exists so tests can prove page persistence,
 * export/import and large-file behaviour against a real Durable Object.
 */
import { DurableObject } from 'cloudflare:workers';
import { DoSqliteDatabase, type SqlParam, type SqlRow } from './database';
import { type DoVfsStats } from './do-vfs';

export interface SqliteTestStats {
  fileName: string;
  fileSize: number;
  /** Bytes used by the DO's own SQLite storage (all tables, incl. vfs2_chunks). */
  storageBytes: number;
  /** Rows in vfs2_chunks for the open file. */
  storedChunks: number;
  /** wasm linear memory size (a floor on the isolate footprint of SQLite itself). */
  wasmHeapBytes: number;
  vfs: DoVfsStats;
  sqliteVersion: string;
}

export interface FillResult {
  rows: number;
  bytesPerRow: number;
  fileSize: number;
  elapsedMs: number;
}

interface CountRow extends Record<string, SqlStorageValue> {
  n: number;
}

/** JSON bodies can only carry the scalar subset of `SqlParam`. */
function isSqlParam(value: unknown): value is SqlParam {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

export class SqliteTestDO extends DurableObject {
  private db: DoSqliteDatabase | undefined;
  private fileName = 'test.db';

  async open(
    fileName = 'test.db',
  ): Promise<{ fileName: string; sqliteVersion: string }> {
    if (this.db !== undefined && this.db.isOpen) {
      if (this.fileName !== fileName)
        throw new Error(`already open on '${this.fileName}'`);
    } else {
      this.fileName = fileName;
      this.db = await DoSqliteDatabase.open(this.ctx, fileName);
    }
    return { fileName, sqliteVersion: this.db.sqliteVersion };
  }

  private database(): DoSqliteDatabase {
    if (this.db === undefined || !this.db.isOpen)
      throw new Error('database not open; call open() first');
    return this.db;
  }

  async exec(sql: string, params?: SqlParam[]): Promise<SqlRow[]> {
    return this.database().exec(sql, params);
  }

  async run(sql: string, params?: SqlParam[]): Promise<{ changes: number }> {
    return this.database().run(sql, params);
  }

  async get(sql: string, params?: SqlParam[]): Promise<SqlRow | undefined> {
    return this.database().get(sql, params);
  }

  async close(): Promise<void> {
    await this.db?.close();
    this.db = undefined;
  }

  async exportDb(): Promise<Uint8Array> {
    return this.database().export();
  }

  async importDb(bytes: Uint8Array): Promise<void> {
    await this.database().import(bytes);
  }

  async checksum(): Promise<string> {
    return this.database().checksum();
  }

  /** Whether this DO instance currently has the database open (false after eviction). */
  isOpen(): boolean {
    return this.db?.isOpen ?? false;
  }

  async stats(): Promise<SqliteTestStats> {
    const db = this.database();
    const storedChunks = this.ctx.storage.sql
      .exec<CountRow>(
        'SELECT COUNT(*) AS n FROM vfs2_chunks WHERE file = ?',
        this.fileName,
      )
      .one().n;
    return {
      fileName: this.fileName,
      fileSize: db.fileSize,
      storageBytes: this.ctx.storage.sql.databaseSize,
      storedChunks,
      wasmHeapBytes: db.wasmHeapBytes,
      vfs: db.vfsStats(),
      sqliteVersion: db.sqliteVersion,
    };
  }

  /**
   * Insert `rows` blobs of `bytesPerRow` random-ish bytes into `blobs(id, data)`
   * in transactions of `batch` rows. Used by the 20 MB test.
   */
  async fillBlobs(
    rows: number,
    bytesPerRow: number,
    batch = 64,
  ): Promise<FillResult> {
    const db = this.database();
    await db.run(
      'CREATE TABLE IF NOT EXISTS blobs (id INTEGER PRIMARY KEY, data BLOB NOT NULL)',
    );
    const started = Date.now();
    let inserted = 0;
    while (inserted < rows) {
      const n = Math.min(batch, rows - inserted);
      await db.transaction(async () => {
        for (let i = 0; i < n; i++) {
          const id = inserted + i;
          const data = new Uint8Array(bytesPerRow);
          // Fill with a cheap per-row pattern so pages are not all identical.
          for (let j = 0; j < data.length; j += 64) data[j] = (id + j) & 0xff;
          await db.run('INSERT INTO blobs (id, data) VALUES (?, ?)', [
            id,
            data,
          ]);
        }
      });
      inserted += n;
    }
    return {
      rows,
      bytesPerRow,
      fileSize: db.fileSize,
      elapsedMs: Date.now() - started,
    };
  }

  /** Sum of blob lengths + row count, read back through SQLite (proves the pages are readable). */
  async verifyBlobs(): Promise<{ rows: number; totalBytes: number }> {
    const row = await this.database().get<{ rows: number; total: number }>(
      'SELECT COUNT(*) AS rows, COALESCE(SUM(length(data)), 0) AS total FROM blobs',
    );
    return { rows: row?.rows ?? 0, totalBytes: row?.total ?? 0 };
  }

  /** Minimal HTTP surface mirroring the RPC methods (POST JSON `{ op, ...args }`). */
  override async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST')
      return new Response('POST { op, ... }', { status: 405 });
    const body: unknown = await request.json();
    if (typeof body !== 'object' || body === null)
      return Response.json({ error: 'bad body' }, { status: 400 });
    const op = Reflect.get(body, 'op');
    const sql = Reflect.get(body, 'sql');
    const params = Reflect.get(body, 'params');
    const sqlParams = Array.isArray(params)
      ? params.filter(isSqlParam)
      : undefined;
    try {
      switch (op) {
        case 'open': {
          const fileName = Reflect.get(body, 'fileName');
          return Response.json(
            await this.open(
              typeof fileName === 'string' ? fileName : undefined,
            ),
          );
        }
        case 'exec':
          if (typeof sql !== 'string')
            return Response.json({ error: 'sql required' }, { status: 400 });
          return Response.json({ rows: await this.exec(sql, sqlParams) });
        case 'run':
          if (typeof sql !== 'string')
            return Response.json({ error: 'sql required' }, { status: 400 });
          return Response.json(await this.run(sql, sqlParams));
        case 'close':
          await this.close();
          return Response.json({ ok: true });
        case 'stats':
          return Response.json(await this.stats());
        case 'export': {
          const bytes = await this.exportDb();
          return new Response(bytes, {
            headers: { 'content-type': 'application/vnd.sqlite3' },
          });
        }
        default:
          return Response.json(
            { error: `unknown op ${String(op)}` },
            { status: 400 },
          );
      }
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  }
}

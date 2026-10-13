/**
 * Background re-compression of legacy (uncompressed) checkpointer blobs.
 *
 * A file imported from the Node runtime arrives with every blob as plain
 * JSON. New writes are gzipped by `blob-codec.ts`, but the imported bulk —
 * which is what makes multi-GB users multi-GB — only shrinks if rewritten.
 * `compactStep` rewrites a bounded batch per call so the user object's alarm
 * can chip away at arbitrarily large files without ever hogging a tick;
 * `finishCompaction` reclaims the freed pages once nothing is left. A step
 * is bounded by rows AND by legacy bytes (`COMPACT_STEP_MAX_BYTES`): it
 * reads one blob at a time and holds every page it rewrites until its
 * COMMIT, so a batch of tool outputs with embedded media must not be able
 * to exhaust the isolate's memory.
 *
 * Lossless by construction: each row's blob is read, gzipped, and written
 * back — the read path decompresses transparently, so the decoded value is
 * bit-identical to what the legacy row held. No row is ever deleted.
 *
 * Selection is by gzip magic (`substr(col, 1, 2) != X'1F8B'`) behind a
 * per-table rowid cursor that the CALLER persists between calls. The cursor
 * is what lets incompressible rows (embedded media that gzip would grow —
 * left unrewritten) be passed over exactly once instead of starving the rows
 * behind them. Rows inserted after compaction started are codec-compressed
 * already, so a monotonic cursor cannot miss anything.
 */
import { gzipBytes, isGzip, MIN_COMPRESS_BYTES } from './blob-codec';
import type { DoSqliteDatabase } from './database';

interface CompactTarget {
  table: string;
  column: string;
}

/** `checkpoints.metadata` is deliberately absent — see blob-codec.ts. */
const TARGETS: readonly CompactTarget[] = [
  { table: 'messages', column: 'message' },
  { table: 'checkpoints', column: 'checkpoint' },
  { table: 'writes', column: 'value' },
];

const textEncoder = new TextEncoder();

/**
 * Legacy bytes one step reads and rewrites at most — except that a step
 * always takes at least one row, however large, so it never stalls.
 */
export const COMPACT_STEP_MAX_BYTES = 8 * 1024 * 1024;

/** Highest rowid examined per table; persist between calls, `{}` to start. */
export type CompactCursors = Record<string, number>;

export interface CompactStepResult {
  /** Rows rewritten this step. */
  rewritten: number;
  /** Bytes saved this step (pre minus post). */
  savedBytes: number;
  /** Rows examined (incl. incompressible ones passed over). */
  examined: number;
  /** Legacy bytes of the rows examined. */
  examinedBytes: number;
  /** True once every table's scan is exhausted. */
  done: boolean;
  /** Updated cursors — persist and pass into the next call. */
  cursors: CompactCursors;
}

/**
 * Examine up to `batch` legacy rows — and at most `maxBytes` of them (at
 * least one row) — and rewrite the compressible ones as gzipped blobs.
 * Call repeatedly (persisting `cursors`) until `done`. Where the steps end
 * changes nothing about the result: rows are visited in the same order and
 * each is rewritten exactly as an unbounded run would.
 */
export async function compactStep(
  db: DoSqliteDatabase,
  batch = 200,
  cursors: CompactCursors = {},
  opts: { maxBytes?: number } = {},
): Promise<CompactStepResult> {
  const maxBytes = opts.maxBytes ?? COMPACT_STEP_MAX_BYTES;
  // One transaction per step: the batch lands atomically and cannot
  // interleave with a turn's own checkpoint transaction.
  return db.transaction(() => compactStepInTx(db, batch, maxBytes, cursors));
}

async function compactStepInTx(
  db: DoSqliteDatabase,
  batch: number,
  maxBytes: number,
  cursors: CompactCursors,
): Promise<CompactStepResult> {
  let budget = batch;
  let rewritten = 0;
  let savedBytes = 0;
  let examined = 0;
  let examinedBytes = 0;
  let full = false;
  let exhausted = true;
  const next: CompactCursors = { ...cursors };

  for (const { table, column } of TARGETS) {
    let cursor = next[table] ?? 0;
    while (budget > 0) {
      // One candidate at a time: the filter loads each value it examines,
      // so a batched query would read every candidate behind the budget.
      const row = await db.get<{ rowid: number; data: Uint8Array | string }>(
        `SELECT rowid, ${column} AS data FROM ${table}
         WHERE rowid > ?
           AND ${column} IS NOT NULL
           AND length(${column}) >= ?
           AND substr(${column}, 1, 2) != X'1F8B'
         ORDER BY rowid
         LIMIT 1`,
        [cursor, MIN_COMPRESS_BYTES],
      );
      if (row === undefined) break;
      const bytes =
        typeof row.data === 'string' ? textEncoder.encode(row.data) : row.data;
      if (examined > 0 && examinedBytes + bytes.length > maxBytes) {
        // Left for the next step, which starts with it.
        full = true;
        break;
      }
      cursor = Math.max(cursor, row.rowid);
      budget -= 1;
      examined += 1;
      examinedBytes += bytes.length;
      if (isGzip(bytes)) continue;
      const compressed = await gzipBytes(bytes);
      // Incompressible (already-compressed media): leave as-is; the cursor
      // has moved past it, so it is never re-attempted.
      if (compressed.length >= bytes.length) continue;
      await db.run(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`, [
        compressed,
        row.rowid,
      ]);
      rewritten += 1;
      savedBytes += bytes.length - compressed.length;
    }
    next[table] = cursor;
    if (budget <= 0 || full) {
      // A budget ran out mid-table — cannot know whether scans are exhausted.
      exhausted = false;
      break;
    }
  }

  return {
    rewritten,
    savedBytes,
    examined,
    examinedBytes,
    done: exhausted,
    cursors: next,
  };
}

/**
 * Reclaim freed pages after compaction. The rebuild (`DoSqliteDatabase.compact`:
 * `VACUUM INTO` a spill file + swap, constant memory) transiently needs
 * about twice the current size in DO storage — refused near the cap so
 * compaction can never be the thing that overflows it. Falls back to
 * `incremental_vacuum` (a no-op on files whose auto_vacuum is NONE, i.e.
 * legacy imports that have never been fully vacuumed).
 */
export async function finishCompaction(
  db: DoSqliteDatabase,
  opts: { fileSize: number; storageCapBytes?: number },
): Promise<{ vacuumed: 'full' | 'incremental' }> {
  const cap = opts.storageCapBytes ?? 10 * 1024 * 1024 * 1024;
  if (opts.fileSize * 2 < cap * 0.9) {
    await db.compact();
    return { vacuumed: 'full' };
  }
  // Refuses to run inside a transaction — hold the transaction mutex (turn
  // checkpoints queue behind) without opening one.
  await db.withoutTransactions(() => db.run('PRAGMA incremental_vacuum'));
  return { vacuumed: 'incremental' };
}

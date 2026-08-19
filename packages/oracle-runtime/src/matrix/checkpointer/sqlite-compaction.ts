import Database, { type Database as DatabaseType } from 'better-sqlite3';

function pragmaNumber(db: DatabaseType, name: string): number {
  const value: unknown = db.pragma(name, { simple: true });
  if (typeof value !== 'number') {
    throw new Error(`Unexpected non-numeric result for PRAGMA ${name}`);
  }
  return value;
}

export interface CompactionThresholds {
  /** Skip files whose freelist is smaller than this many bytes. */
  minFreelistBytes: number;
  /** Skip files whose freelist is a smaller share of total pages than this. */
  minFreelistRatio: number;
}

export const DEFAULT_COMPACTION_THRESHOLDS: CompactionThresholds = {
  minFreelistBytes: 10 * 1024 * 1024,
  minFreelistRatio: 0.2,
};

export interface CompactionResult {
  compacted: boolean;
  freelistBytes: number;
  fileBytesBefore: number;
  fileBytesAfter: number;
}

/**
 * One-time migration for databases created before incremental auto-vacuum:
 * when a meaningful share of the file is dead freelist pages, rebuild it
 * with VACUUM (which also flips the file to incremental mode, so the saver's
 * per-prune `incremental_vacuum` keeps it compact from then on). Call only
 * while no request holds the file — VACUUM takes an exclusive lock to commit.
 */
export function compactSqliteFileIfBloated(
  dbPath: string,
  thresholds: CompactionThresholds = DEFAULT_COMPACTION_THRESHOLDS,
): CompactionResult {
  // `fileMustExist: true` — compaction must never create the DB it's meant
  // to compact. Without this, a race with corruption recovery/cleanup
  // unlinking the file concurrently would silently create an empty 0-byte
  // database here (better-sqlite3's default create-if-missing behavior);
  // the caller would then checksum, snapshot, and upload that empty DB over
  // the user's good Matrix backup. Throwing instead lands in the caller's
  // existing warn-and-continue catch.
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    const pageSize = pragmaNumber(db, 'page_size');
    const pageCount = pragmaNumber(db, 'page_count');
    const freelistCount = pragmaNumber(db, 'freelist_count');
    const freelistBytes = freelistCount * pageSize;
    const fileBytesBefore = pageCount * pageSize;

    if (
      pageCount === 0 ||
      freelistBytes < thresholds.minFreelistBytes ||
      freelistCount / pageCount < thresholds.minFreelistRatio
    ) {
      return {
        compacted: false,
        freelistBytes,
        fileBytesBefore,
        fileBytesAfter: fileBytesBefore,
      };
    }

    db.pragma('auto_vacuum = INCREMENTAL');
    db.exec('VACUUM');
    const pagesAfter = pragmaNumber(db, 'page_count');
    return {
      compacted: true,
      freelistBytes,
      fileBytesBefore,
      fileBytesAfter: pagesAfter * pageSize,
    };
  } finally {
    db.close();
  }
}

/**
 * Write a transactionally consistent, freelist-free copy of the database to
 * `snapshotPath` via VACUUM INTO. Read-only on the source, so concurrent
 * writers are safe — this is what makes the Matrix upload immune to catching
 * the live file mid-transaction. The target must not already exist.
 */
export function snapshotSqliteFile(dbPath: string, snapshotPath: string): void {
  const db = new Database(dbPath, { readonly: true });
  try {
    db.pragma('busy_timeout = 5000');
    db.prepare('VACUUM INTO ?').run(snapshotPath);
  } finally {
    db.close();
  }
}

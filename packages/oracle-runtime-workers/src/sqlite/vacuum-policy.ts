/**
 * When the user object may rebuild its working copy without free pages.
 *
 * `VACUUM` (via `DoSqliteDatabase.compact`) holds the transaction lock for
 * the whole rewrite and transiently doubles the file in DO storage, so it
 * only runs on a quiet object with a file that is actually worth it. The
 * predicate is pure so the thresholds are testable; the object supplies the
 * numbers from its alarm tick.
 */

/** No turn for this long before the object counts as quiet. */
export const VACUUM_IDLE_MS = 10 * 60_000;
/** Files below this are cheap enough to leave alone. */
export const VACUUM_MIN_FILE_BYTES = 4 * 1024 * 1024;
/** Free-page share that makes the rewrite worth its cost. */
export const VACUUM_MIN_FREE_SHARE = 0.2;
/** At most one rebuild per object per this interval. */
export const VACUUM_MIN_INTERVAL_MS = 6 * 60 * 60_000;
/** DO SQLite storage cap; the rewrite needs 2× the file below it. */
export const DO_STORAGE_CAP_BYTES = 10 * 1024 * 1024 * 1024;

export interface VacuumPolicyInput {
  now: number;
  lastAccessAt: number;
  lastVacuumAt: number | undefined;
  /** Unflushed changes pending for the owner store. */
  dirty: boolean;
  /** An owner-store flush is reading the file right now. */
  exporting: boolean;
  fileBytes: number;
  pageCount: number;
  freelistCount: number;
}

export type VacuumVerdict =
  | { vacuum: true; freeShare: number }
  | { vacuum: false; reason: string; freeShare: number };

export function shouldVacuum(input: VacuumPolicyInput): VacuumVerdict {
  const freeShare =
    input.pageCount > 0 ? input.freelistCount / input.pageCount : 0;
  const no = (reason: string): VacuumVerdict => ({
    vacuum: false,
    reason,
    freeShare,
  });
  if (input.exporting) return no('owner-store flush in progress');
  if (input.dirty) return no('working copy dirty (flush first)');
  if (input.now - input.lastAccessAt < VACUUM_IDLE_MS)
    return no('object active within the idle window');
  if (input.fileBytes < VACUUM_MIN_FILE_BYTES) return no('file too small');
  if (freeShare <= VACUUM_MIN_FREE_SHARE)
    return no('free share below threshold');
  if (
    input.lastVacuumAt !== undefined &&
    input.now - input.lastVacuumAt < VACUUM_MIN_INTERVAL_MS
  )
    return no('vacuumed recently');
  if (input.fileBytes * 2 >= DO_STORAGE_CAP_BYTES * 0.9)
    return no('not enough storage headroom for the rewrite');
  return { vacuum: true, freeShare };
}

/**
 * Whether the numbers say a rebuild is wanted at all (ignoring quiet-time
 * and interval gates) — used to re-arm the alarm for a later check.
 */
export function vacuumWanted(input: VacuumPolicyInput): boolean {
  const verdict = shouldVacuum({
    ...input,
    dirty: false,
    exporting: false,
    lastAccessAt: input.now - VACUUM_IDLE_MS,
    lastVacuumAt: undefined,
  });
  return verdict.vacuum;
}

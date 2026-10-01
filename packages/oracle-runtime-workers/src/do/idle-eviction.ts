/**
 * Dropping an idle user's working copy. The object only drops it when the
 * owner copy upstream is verified current, and that check awaits (the
 * checksum reads the whole file, from R2 for tiered pages), and while an
 * object awaits I/O other than its own storage a request can arrive. So
 * whatever the tick decided before is re-read after the check, and the
 * in-memory handles are dropped before the first await of the wipe: from
 * then on a request boots afresh from the owner copy instead of reaching a
 * database being deleted under it.
 */
export interface IdleEvictionSteps {
  /** The owner copy matches the working copy (may await network I/O). */
  ownerCopyIsCurrent(): Promise<boolean>;
  /** Everything that decides idleness, read again: still no activity. */
  stillIdle(): Promise<boolean>;
  /** Forget the in-memory handles. Synchronous, so nothing interleaves. */
  dropHandles(): void;
  /** Delete the working copy. */
  wipe(): Promise<void>;
}

export type IdleEvictionOutcome =
  /** The working copy was deleted. */
  | 'evicted'
  /** The owner copy is not verified current: keep the working copy. */
  | 'not-current'
  /** Activity arrived while the owner copy was checked: keep it. */
  | 'active';

export async function evictIdleWorkingCopy(
  steps: IdleEvictionSteps,
): Promise<IdleEvictionOutcome> {
  if (!(await steps.ownerCopyIsCurrent())) return 'not-current';
  if (!(await steps.stillIdle())) return 'active';
  steps.dropHandles();
  await steps.wipe();
  return 'evicted';
}

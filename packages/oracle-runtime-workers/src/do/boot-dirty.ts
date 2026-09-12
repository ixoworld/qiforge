/**
 * Whether a freshly opened working copy has writes the system of record has
 * not seen. The dirty mark is normally set at the end of a turn; a turn that
 * died in the middle (an object reset, a provider error, the user's stop)
 * leaves LangGraph's per-step checkpoints committed in SQLite with no mark,
 * and the upload waits for whatever dirties the object next — possibly
 * never, and a reload from the system of record would drop those steps. The
 * VFS records a write generation with the file and the object records the
 * generation it last uploaded; a mismatch on boot is the missing mark.
 */
export interface BootDirtyInput {
  /** The object's in-memory flag (a warm boot already knows). */
  dirtyInMemory: boolean;
  /** The persisted `meta:dirty` flag. */
  dirtyFlag: unknown;
  /** The persisted generation of the last successful upload (undefined = never uploaded). */
  uploadedGen: unknown;
  /** The working copy's current write generation. */
  writeGeneration: number;
}

export type BootDirtyDecision =
  | 'already-dirty'
  /** The persisted flag is set: adopt it (the flush alarm is armed already). */
  | 'flagged'
  /** Never uploaded: the first completed turn marks and flushes; nothing to reconcile. */
  | 'never-uploaded'
  /** Writes after the last upload with no mark: mark dirty now. */
  | 'behind-upload'
  | 'clean';

export function decideBootDirty(input: BootDirtyInput): BootDirtyDecision {
  if (input.dirtyInMemory) return 'already-dirty';
  if (input.dirtyFlag === true) return 'flagged';
  if (typeof input.uploadedGen !== 'number') return 'never-uploaded';
  if (input.uploadedGen !== input.writeGeneration) return 'behind-upload';
  return 'clean';
}

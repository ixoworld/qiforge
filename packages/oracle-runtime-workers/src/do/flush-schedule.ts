/**
 * Whether a housekeeping wake should upload the working copy to the owner
 * store. The object's single alarm serves several clients (realtime
 * heartbeats, the durable-run keep-alive, task runs, compaction, the R2
 * tier, idle eviction), so a wake says nothing about WHY it happened. The
 * flush has its own persisted deadline (`meta:flushAt`, armed by the first
 * write after an upload and replaced by the retry delay after a failure)
 * and runs only when that deadline is due — every other wake leaves a
 * dirty copy alone. Two exceptions upload right away: a copy about to be
 * evicted (the wipe must never drop unsaved turns) and a copy marked dirty
 * before the deadline existed (older objects; one upload, then the
 * debounce applies).
 */
export interface FlushScheduleInput {
  /** The object holds writes the owner store has not seen (and a database is open). */
  dirty: boolean;
  /** The persisted flush deadline (undefined = none recorded). */
  flushAt: unknown;
  now: number;
  /** The idle-eviction path is about to wipe the working copy. */
  idle: boolean;
}

export type FlushScheduleDecision =
  | { action: 'skip'; reason: 'clean' }
  | { action: 'flush'; reason: 'due' | 'idle' | 'no-deadline' }
  | { action: 'wait'; at: number };

/** Alarms fire a hair early; a deadline this close counts as due. */
export const FLUSH_DUE_SLACK_MS = 1000;

export function decideFlush(input: FlushScheduleInput): FlushScheduleDecision {
  if (!input.dirty) return { action: 'skip', reason: 'clean' };
  if (input.idle) return { action: 'flush', reason: 'idle' };
  if (typeof input.flushAt !== 'number' || !Number.isFinite(input.flushAt))
    return { action: 'flush', reason: 'no-deadline' };
  if (input.flushAt <= input.now + FLUSH_DUE_SLACK_MS)
    return { action: 'flush', reason: 'due' };
  return { action: 'wait', at: input.flushAt };
}

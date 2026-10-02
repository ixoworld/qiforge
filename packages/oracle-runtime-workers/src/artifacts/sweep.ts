/**
 * Removes expired artefact share copies from R2 on the cron tick.
 *
 * The data route deletes an expired copy only when someone opens it, so a
 * copy nobody opens again would stay in the bucket for good. This sweep lists
 * `art/` with each object's custom metadata (no per-object read) and deletes
 * the ones whose `expiresAt` has passed.
 *
 * Cost per tick is kept to one state read while the last full sweep is
 * recent. A sweep lists at most `maxPages` pages per tick; a larger bucket is
 * finished over the next ticks from the stored cursor. The state object lives
 * outside `art/`, so an operator's lifecycle rule on that prefix never removes
 * it.
 *
 * Two overlapping runs need no lock: the second one only re-deletes keys the
 * first already deleted (a no-op) and writes the same kind of state.
 */
import { z } from 'zod';
import type { Logger } from '../plugin-api/types';
import { ARTIFACT_OBJECT_PREFIX } from './store';

export const ARTIFACT_SWEEP_STATE_KEY = 'artifact-sweep/state';

/** R2's own ceiling for one `list` page and for one multi-key `delete`. */
const R2_MAX_BATCH = 1000;
const DEFAULT_SWEEP_MAX_PAGES = 20;

const sweepStateSchema = z.object({
  v: z.literal(1),
  sweptAt: z.string().nullable(),
  cursor: z.string().nullable(),
});

export type ArtifactSweepState = z.infer<typeof sweepStateSchema>;

const NEVER_SWEPT: ArtifactSweepState = { v: 1, sweptAt: null, cursor: null };

export interface SweepStats {
  pages: number;
  seen: number;
  deleted: number;
  /** Objects without a readable `expiresAt`: left alone. */
  unknown: number;
  /** The call continued a sweep an earlier tick left unfinished. */
  resumed: boolean;
  elapsedMs: number;
}

export type SweepOutcome =
  | { skipped: true }
  | ({ skipped: false; done: boolean } & SweepStats)
  | ({ skipped: false; error: string } & SweepStats);

export interface SweepOptions {
  bucket: R2Bucket;
  /** Clock for the expiry comparison and `sweptAt` (default `Date.now()`). */
  now?: number;
  /** A full sweep starts at most this often; an unfinished one resumes on every call. */
  intervalMs: number;
  /** Objects per `list` call (default and maximum 1000). */
  pageSize?: number;
  /** `list` calls per invocation (default 20). */
  maxPages?: number;
  /** Keys per `delete` call (default and maximum 1000). */
  deleteBatchSize?: number;
  log: Pick<Logger, 'log' | 'error'>;
}

function clampBatch(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isInteger(value) || value < 1)
    return fallback;
  return Math.min(value, R2_MAX_BATCH);
}

/** A missing, unreadable or unknown-version state counts as "never swept". */
async function readState(bucket: R2Bucket): Promise<ArtifactSweepState> {
  const object = await bucket.get(ARTIFACT_SWEEP_STATE_KEY);
  if (!object) return NEVER_SWEPT;
  const text = await object.text();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return NEVER_SWEPT;
  }
  const parsed = sweepStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : NEVER_SWEPT;
}

function isExpired(
  expiresAt: string | undefined,
  now: number,
): boolean | undefined {
  const at = Date.parse(expiresAt ?? '');
  return Number.isFinite(at) ? at <= now : undefined;
}

/** Never throws: an R2 failure is logged once and returned as `error`. */
export async function sweepExpiredArtifacts(
  opts: SweepOptions,
): Promise<SweepOutcome> {
  const started = Date.now();
  const stats: SweepStats = {
    pages: 0,
    seen: 0,
    deleted: 0,
    unknown: 0,
    resumed: false,
    elapsedMs: 0,
  };
  const summary = (): string =>
    `pages=${stats.pages} seen=${stats.seen} deleted=${stats.deleted} unknown=${stats.unknown} resumed=${stats.resumed} elapsedMs=${stats.elapsedMs}`;
  try {
    const { bucket } = opts;
    const now = opts.now ?? Date.now();
    const pageSize = clampBatch(opts.pageSize, R2_MAX_BATCH);
    const deleteBatchSize = clampBatch(opts.deleteBatchSize, R2_MAX_BATCH);
    const maxPages =
      opts.maxPages !== undefined &&
      Number.isInteger(opts.maxPages) &&
      opts.maxPages >= 1
        ? opts.maxPages
        : DEFAULT_SWEEP_MAX_PAGES;

    const state = await readState(bucket);
    if (state.cursor === null && state.sweptAt !== null) {
      const sweptAt = Date.parse(state.sweptAt);
      if (Number.isFinite(sweptAt) && now - sweptAt < opts.intervalMs)
        return { skipped: true };
    }

    stats.resumed = state.cursor !== null;
    let cursor: string | undefined = state.cursor ?? undefined;
    let finished = false;
    while (stats.pages < maxPages) {
      const page = await bucket.list({
        prefix: ARTIFACT_OBJECT_PREFIX,
        limit: pageSize,
        include: ['customMetadata'],
        ...(cursor !== undefined ? { cursor } : {}),
      });
      stats.pages++;
      stats.seen += page.objects.length;
      const expired: string[] = [];
      for (const object of page.objects) {
        const verdict = isExpired(object.customMetadata?.expiresAt, now);
        if (verdict === undefined) stats.unknown++;
        else if (verdict) expired.push(object.key);
      }
      for (let i = 0; i < expired.length; i += deleteBatchSize) {
        const batch = expired.slice(i, i + deleteBatchSize);
        await bucket.delete(batch);
        stats.deleted += batch.length;
      }
      // `truncated`, never the page length: with `include` set R2 may return
      // fewer objects than `limit` while more remain.
      if (!page.truncated) {
        finished = true;
        break;
      }
      cursor = page.cursor;
    }

    const next: ArtifactSweepState = finished
      ? { v: 1, sweptAt: new Date(now).toISOString(), cursor: null }
      : { v: 1, sweptAt: state.sweptAt, cursor: cursor ?? null };
    await bucket.put(ARTIFACT_SWEEP_STATE_KEY, JSON.stringify(next), {
      httpMetadata: { contentType: 'application/json' },
    });
    stats.elapsedMs = Date.now() - started;
    opts.log.log(
      `[artifacts] sweep ${finished ? 'finished' : 'paused, resumes next tick'}: ${summary()}`,
    );
    return { skipped: false, done: finished, ...stats };
  } catch (error) {
    stats.elapsedMs = Date.now() - started;
    const message = error instanceof Error ? error.message : String(error);
    opts.log.error(`[artifacts] sweep failed: ${message} (${summary()})`);
    // A stored cursor R2 no longer accepts would fail every tick at its
    // first list. Dropping it costs one write now and a sweep from the start
    // next tick; a transient failure at that point pays the same price.
    if (stats.resumed && stats.pages === 0)
      await dropCursor(opts.bucket, opts.log).catch(() => undefined);
    return { skipped: false, error: message, ...stats };
  }
}

async function dropCursor(
  bucket: R2Bucket,
  log: Pick<Logger, 'log'>,
): Promise<void> {
  const state = await readState(bucket);
  if (state.cursor === null) return;
  await bucket.put(
    ARTIFACT_SWEEP_STATE_KEY,
    JSON.stringify({ ...state, cursor: null }),
    { httpMetadata: { contentType: 'application/json' } },
  );
  log.log('[artifacts] sweep dropped its stored cursor; next tick starts over');
}

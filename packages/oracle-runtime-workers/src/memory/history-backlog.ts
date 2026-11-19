/**
 * Durable record of sessions whose history may still hold messages the
 * memory engine has not taken, for the user object's housekeeping alarm to
 * upload when no live trigger comes: the person does not come back, the
 * quiet-period timer died with the instance (a deploy, an eviction from
 * memory), or a pass was refused or ran out of budget.
 *
 * One storage key per session (`history:backlog:<sessionId>`), written when
 * a pass is scheduled (`note`) and when one ends (`record`). The catch-up
 * takes a few due sessions per tick (`takeDue`). A session that keeps
 * failing without progress is looked at less and less often (5 min doubling
 * to 6 h) and dropped after `HISTORY_BACKLOG_MAX_ATTEMPTS`, so a dead engine
 * or a user without a delegation never keeps an object awake for long; its
 * count stays where it is, and the next live trigger uploads from there.
 *
 * Sessions that were stuck before this record existed are found once
 * (`seed`): the most recent conversations updated within the seed window.
 */
import type { Logger } from '../plugin-api/types';
import type { PassEnd } from './session-history-indexer';

export const HISTORY_BACKLOG_PREFIX = 'history:backlog:';
/** Set once the most recent sessions were recorded (`seed`). */
export const META_HISTORY_BACKLOG_SEEDED = 'meta:historyBacklogSeeded';
/** First wait, after a trigger or a pass that moved the count; doubles per pass without progress. */
export const HISTORY_BACKLOG_FIRST_DELAY_MS = 5 * 60_000;
export const HISTORY_BACKLOG_MAX_DELAY_MS = 6 * 3_600_000;
/**
 * Passes without progress before a session is dropped from the record. A
 * catch-up pass counts when it is taken, so one that never reports (the
 * isolate died, a call hung) counts too.
 */
export const HISTORY_BACKLOG_MAX_ATTEMPTS = 8;
/** Sessions one catch-up run takes (one run at a time per object). */
export const HISTORY_BACKLOG_PER_TICK = 3;
/** The seed looks at this many of the most recent conversations… */
export const HISTORY_BACKLOG_SEED_SESSIONS = 5;
/** …updated within this window. */
export const HISTORY_BACKLOG_SEED_WINDOW_MS = 14 * 24 * 3_600_000;
/** Keys read per listing (a user has a handful at most). */
const LIST_LIMIT = 100;

export interface HistoryBacklogEntry {
  /** Passes in a row that ended with a backlog and did not move the count. */
  attempts: number;
  /** The catch-up starts a pass no earlier than this. */
  nextAt: number;
  /** Last time a trigger asked for a pass; a pass that started before it does not clear the entry. */
  notedAt: number;
  /** Taken by the catch-up, whose pass has not reported yet (its attempt is already counted). */
  claimed?: boolean;
}

function delayFor(attempts: number): number {
  return Math.min(
    HISTORY_BACKLOG_MAX_DELAY_MS,
    HISTORY_BACKLOG_FIRST_DELAY_MS * 2 ** attempts,
  );
}

/** The part of `DurableObjectStorage` the record uses. */
export interface BacklogStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(options: {
    prefix: string;
    limit: number;
  }): Promise<Map<string, unknown>>;
}

function isEntry(value: unknown): value is HistoryBacklogEntry {
  if (typeof value !== 'object' || value === null) return false;
  const attempts: unknown = Reflect.get(value, 'attempts');
  const nextAt: unknown = Reflect.get(value, 'nextAt');
  const notedAt: unknown = Reflect.get(value, 'notedAt');
  return (
    typeof attempts === 'number' &&
    typeof nextAt === 'number' &&
    typeof notedAt === 'number'
  );
}

export class HistoryBacklog {
  /** Every read-modify-write runs in call order, so a `note` is never lost under a `record`. */
  private queue: Promise<unknown> = Promise.resolve();

  /** `seeded()` once it answered true (it never turns false). */
  private seededKnown = false;

  constructor(
    private readonly storage: BacklogStorage,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  private serial<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async read(sessionId: string): Promise<HistoryBacklogEntry | null> {
    const value = await this.storage.get(HISTORY_BACKLOG_PREFIX + sessionId);
    return isEntry(value) ? value : null;
  }

  private async entries(): Promise<Array<[string, HistoryBacklogEntry]>> {
    const listed = await this.storage.list({
      prefix: HISTORY_BACKLOG_PREFIX,
      limit: LIST_LIMIT,
    });
    const out: Array<[string, HistoryBacklogEntry]> = [];
    for (const [key, value] of listed)
      if (isEntry(value))
        out.push([key.slice(HISTORY_BACKLOG_PREFIX.length), value]);
    return out;
  }

  /**
   * A trigger scheduled a pass: the catch-up looks at the session no earlier
   * than `notBefore` (the live pass normally settles it first). Attempts
   * carry over.
   */
  note(sessionId: string, notBefore: number): Promise<void> {
    return this.serial(async () => {
      const prev = await this.read(sessionId);
      await this.storage.put(HISTORY_BACKLOG_PREFIX + sessionId, {
        attempts: prev?.attempts ?? 0,
        nextAt: Math.max(prev?.nextAt ?? 0, notBefore),
        notedAt: this.now(),
        ...(prev?.claimed ? { claimed: true } : {}),
      });
    });
  }

  /**
   * A pass ended. Returns when the catch-up should look at the session
   * again, or null when it is off the record.
   */
  record(sessionId: string, end: PassEnd): Promise<number | null> {
    const { startedAt } = end;
    return this.serial(async () => {
      const key = HISTORY_BACKLOG_PREFIX + sessionId;
      const prev = await this.read(sessionId);
      const now = this.now();
      if (!end.backlog) {
        // A trigger that came while the pass ran asked for more than it saw.
        if (prev && prev.notedAt > startedAt) return prev.nextAt;
        if (prev) await this.storage.delete(key);
        return null;
      }
      // A pass the catch-up took was counted when it was taken.
      const attempts = end.progressed
        ? 0
        : prev?.claimed
          ? prev.attempts
          : (prev?.attempts ?? 0) + 1;
      if (attempts > HISTORY_BACKLOG_MAX_ATTEMPTS) {
        this.logger.warn(
          `[history-indexer] session ${sessionId}: ${HISTORY_BACKLOG_MAX_ATTEMPTS} catch-up passes in a row ended without progress; dropping it from the catch-up (its next trigger uploads from where the count stands)`,
        );
        await this.storage.delete(key);
        return null;
      }
      const delayMs = Math.max(delayFor(attempts), end.retryAfterMs ?? 0);
      const nextAt = now + delayMs;
      await this.storage.put(key, {
        attempts,
        nextAt,
        notedAt: prev?.notedAt ?? now,
      });
      return nextAt;
    });
  }

  /** The session is gone (deleted): off the record. */
  forget(sessionId: string): Promise<void> {
    return this.serial(async () => {
      await this.storage.delete(HISTORY_BACKLOG_PREFIX + sessionId);
    });
  }

  /**
   * Up to `max` sessions due now, oldest due first, each counted as an
   * attempt and pushed back by its delay (a pass that never reports is looked
   * at again later, and dropped after `HISTORY_BACKLOG_MAX_ATTEMPTS`). A
   * `busy` session (a run in progress) is pushed back by the first delay
   * without a pass: a pass in the middle of a turn would split it. Returns
   * the sessions taken and when the record is next due (null: empty).
   */
  takeDue(
    max: number,
    busy: (sessionId: string) => boolean,
  ): Promise<{ taken: string[]; next: number | null }> {
    return this.serial(async () => {
      const now = this.now();
      const entries = await this.entries();
      const due = entries
        .filter(([, entry]) => entry.nextAt <= now)
        .sort((a, b) => a[1].nextAt - b[1].nextAt);
      const taken: string[] = [];
      const updated = new Map<string, HistoryBacklogEntry | null>();
      for (const [sessionId, entry] of due) {
        const key = HISTORY_BACKLOG_PREFIX + sessionId;
        if (busy(sessionId)) {
          const next = {
            ...entry,
            nextAt: now + HISTORY_BACKLOG_FIRST_DELAY_MS,
          };
          await this.storage.put(key, next);
          updated.set(sessionId, next);
          continue;
        }
        if (taken.length >= max) continue;
        const attempts = entry.attempts + 1;
        if (attempts > HISTORY_BACKLOG_MAX_ATTEMPTS) {
          this.logger.warn(
            `[history-indexer] session ${sessionId}: ${HISTORY_BACKLOG_MAX_ATTEMPTS} catch-up passes in a row ended without progress or never reported; dropping it from the catch-up (its next trigger uploads from where the count stands)`,
          );
          await this.storage.delete(key);
          updated.set(sessionId, null);
          continue;
        }
        const next = {
          attempts,
          nextAt: now + delayFor(attempts),
          notedAt: entry.notedAt,
          claimed: true,
        };
        await this.storage.put(key, next);
        updated.set(sessionId, next);
        taken.push(sessionId);
      }
      let next: number | null = null;
      for (const [sessionId, entry] of entries) {
        const current = updated.has(sessionId) ? updated.get(sessionId) : entry;
        if (current)
          next =
            next === null ? current.nextAt : Math.min(next, current.nextAt);
      }
      return { taken, next };
    });
  }

  /** Whether the most recent sessions were recorded once already. */
  async seeded(): Promise<boolean> {
    if (!this.seededKnown)
      this.seededKnown =
        (await this.storage.get(META_HISTORY_BACKLOG_SEEDED)) !== undefined;
    return this.seededKnown;
  }

  /**
   * Once per object: record the sessions updated within the seed window
   * (the caller passes the most recent conversations), due now. A pass over
   * a session with nothing new sends nothing and takes it off the record.
   */
  seed(
    sessions: ReadonlyArray<{ sessionId: string; lastUpdatedAt: number }>,
  ): Promise<number> {
    return this.serial(async () => {
      const now = this.now();
      let added = 0;
      for (const { sessionId, lastUpdatedAt } of sessions) {
        if (!(now - lastUpdatedAt <= HISTORY_BACKLOG_SEED_WINDOW_MS)) continue;
        if (await this.read(sessionId)) continue;
        await this.storage.put(HISTORY_BACKLOG_PREFIX + sessionId, {
          attempts: 0,
          nextAt: now,
          notedAt: now,
        });
        added += 1;
      }
      await this.storage.put(META_HISTORY_BACKLOG_SEEDED, now);
      this.seededKnown = true;
      return added;
    });
  }

  /** Indexing is off: nothing on the record can be uploaded. */
  clear(): Promise<void> {
    return this.serial(async () => {
      for (const [sessionId] of await this.entries())
        await this.storage.delete(HISTORY_BACKLOG_PREFIX + sessionId);
    });
  }
}

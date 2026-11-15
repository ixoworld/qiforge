/**
 * The durable history backlog record over an in-memory storage: what a
 * trigger and a pass write, when the catch-up looks again, the bound on
 * passes without progress, busy sessions, the one-time seed.
 */
import { describe, expect, it } from 'vitest';
import type { Logger } from '../plugin-api/types';
import {
  HISTORY_BACKLOG_FIRST_DELAY_MS,
  HISTORY_BACKLOG_MAX_ATTEMPTS,
  HISTORY_BACKLOG_MAX_DELAY_MS,
  HISTORY_BACKLOG_PREFIX,
  HISTORY_BACKLOG_SEED_WINDOW_MS,
  HistoryBacklog,
  type BacklogStorage,
} from './history-backlog';

function memoryStorage(): BacklogStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (key: string) => data.get(key),
    put: async (key: string, value: unknown) => {
      data.set(key, structuredClone(value));
    },
    delete: async (key: string) => data.delete(key),
    list: async ({ prefix, limit }: { prefix: string; limit: number }) => {
      const out = new Map<string, unknown>();
      for (const key of [...data.keys()].sort()) {
        if (!key.startsWith(prefix)) continue;
        if (out.size >= limit) break;
        out.set(key, data.get(key));
      }
      return out;
    },
  };
}

function setup() {
  let now = 1_000_000;
  const warnings: string[] = [];
  const logger: Logger = {
    log: () => undefined,
    warn: (line: string) => void warnings.push(line),
    error: () => undefined,
  };
  const storage = memoryStorage();
  const backlog = new HistoryBacklog(storage, logger, () => now);
  return {
    backlog,
    storage,
    warnings,
    at: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const keys = (s: ReturnType<typeof setup>) =>
  [...s.storage.data.keys()].filter((k) =>
    k.startsWith(HISTORY_BACKLOG_PREFIX),
  );

describe('HistoryBacklog', () => {
  it('a finished pass with nothing left clears what its trigger noted', async () => {
    const s = setup();
    await s.backlog.note('s1', s.at() + 1000);
    s.advance(10);
    await expect(
      s.backlog.record('s1', {
        backlog: false,
        progressed: true,
        startedAt: s.at(),
      }),
    ).resolves.toBeNull();
    expect(keys(s)).toEqual([]);
    await expect(s.backlog.takeDue(3, () => false)).resolves.toEqual({
      taken: [],
      next: null,
    });
  });

  it('keeps the entry when a trigger came after the pass started', async () => {
    const s = setup();
    const startedAt = s.at();
    s.advance(10);
    await s.backlog.note('s1', s.at() + 5000);
    const next = await s.backlog.record('s1', {
      backlog: false,
      progressed: true,
      startedAt,
    });
    expect(next).toBe(s.at() + 5000);
    expect(keys(s)).toEqual([`${HISTORY_BACKLOG_PREFIX}s1`]);
  });

  it('a backlog that moved is looked at again after the first delay; one that did not, ever later, then dropped', async () => {
    const s = setup();
    const progressed = await s.backlog.record('s1', {
      backlog: true,
      progressed: true,
      startedAt: s.at(),
    });
    expect(progressed).toBe(s.at() + HISTORY_BACKLOG_FIRST_DELAY_MS);
    const waits: number[] = [];
    for (let i = 0; i < HISTORY_BACKLOG_MAX_ATTEMPTS; i += 1) {
      const at = await s.backlog.record('s1', {
        backlog: true,
        progressed: false,
        startedAt: s.at(),
      });
      waits.push((at ?? 0) - s.at());
    }
    expect(waits[0]).toBe(2 * HISTORY_BACKLOG_FIRST_DELAY_MS);
    expect(waits[1]).toBe(4 * HISTORY_BACKLOG_FIRST_DELAY_MS);
    expect(Math.max(...waits)).toBe(HISTORY_BACKLOG_MAX_DELAY_MS);
    // One more pass without progress: off the record, with a warning.
    await expect(
      s.backlog.record('s1', {
        backlog: true,
        progressed: false,
        startedAt: s.at(),
      }),
    ).resolves.toBeNull();
    expect(keys(s)).toEqual([]);
    expect(s.warnings.join('\n')).toContain('dropping it from the catch-up');
  });

  it("honours the engine's retry_after_ms as a floor", async () => {
    const s = setup();
    const at = await s.backlog.record('s1', {
      backlog: true,
      progressed: true,
      retryAfterMs: 3 * 3_600_000,
      startedAt: s.at(),
    });
    expect(at).toBe(s.at() + 3 * 3_600_000);
  });

  it('hands out at most N due sessions, oldest due first, pushes them back, and skips busy ones without a pass', async () => {
    const s = setup();
    for (const [id, offset] of [
      ['a', 30],
      ['b', 10],
      ['c', 20],
      ['busy', 0],
      ['later', 60_000],
    ] as const)
      await s.backlog.note(id, s.at() + offset);
    s.advance(100);
    const first = await s.backlog.takeDue(2, (id) => id === 'busy');
    expect(first.taken).toEqual(['b', 'c']);
    // 'a' is still due (its own time, already past).
    expect(first.next).toBeLessThanOrEqual(s.at());
    const second = await s.backlog.takeDue(5, () => false);
    expect(second.taken).toEqual(['a']);
    // Busy waits the first delay; 'later' is next.
    expect(second.next).toBe(s.at() - 100 + 60_000);
  });

  it('counts a take as an attempt, so a pass that never reports is dropped after the maximum', async () => {
    const s = setup();
    await s.backlog.note('s1', s.at());
    for (let i = 0; i < HISTORY_BACKLOG_MAX_ATTEMPTS; i += 1) {
      const { taken, next } = await s.backlog.takeDue(3, () => false);
      expect(taken).toEqual(['s1']);
      expect(next! - s.at()).toBe(
        Math.min(
          HISTORY_BACKLOG_MAX_DELAY_MS,
          HISTORY_BACKLOG_FIRST_DELAY_MS * 2 ** (i + 1),
        ),
      );
      s.advance(next! - s.at());
    }
    await expect(s.backlog.takeDue(3, () => false)).resolves.toEqual({
      taken: [],
      next: null,
    });
    expect(s.warnings.join('\n')).toContain('never reported');
  });

  it('a taken pass that reports no progress is not counted twice; progress resets', async () => {
    const s = setup();
    await s.backlog.note('s1', s.at());
    await s.backlog.takeDue(3, () => false); // attempt 1
    const at = await s.backlog.record('s1', {
      backlog: true,
      progressed: false,
      startedAt: s.at(),
    });
    expect(at! - s.at()).toBe(2 * HISTORY_BACKLOG_FIRST_DELAY_MS);
    const reset = await s.backlog.record('s1', {
      backlog: true,
      progressed: true,
      startedAt: s.at(),
    });
    expect(reset! - s.at()).toBe(HISTORY_BACKLOG_FIRST_DELAY_MS);
  });

  it('seeds the recent sessions once, due now, and never the old ones', async () => {
    const s = setup();
    await expect(s.backlog.seeded()).resolves.toBe(false);
    await s.backlog.note('noted', s.at() + 999_999);
    const added = await s.backlog.seed([
      { sessionId: 'recent', lastUpdatedAt: s.at() - 1000 },
      { sessionId: 'noted', lastUpdatedAt: s.at() },
      {
        sessionId: 'old',
        lastUpdatedAt: s.at() - HISTORY_BACKLOG_SEED_WINDOW_MS - 1,
      },
      { sessionId: 'bad-date', lastUpdatedAt: Number.NaN },
    ]);
    expect(added).toBe(1);
    await expect(s.backlog.seeded()).resolves.toBe(true);
    await expect(s.backlog.takeDue(5, () => false)).resolves.toMatchObject({
      taken: ['recent'],
    });
  });

  it('clear() drops every entry', async () => {
    const s = setup();
    await s.backlog.note('a', 0);
    await s.backlog.note('b', 0);
    await s.backlog.clear();
    expect(keys(s)).toEqual([]);
  });

  it('serialises a note behind a pending record (neither is lost)', async () => {
    const s = setup();
    const startedAt = s.at();
    // Both are called without awaiting in between: they run in call order.
    const recorded = s.backlog.record('s1', {
      backlog: false,
      progressed: true,
      startedAt,
    });
    s.advance(5);
    const noted = s.backlog.note('s1', s.at() + 1000);
    await Promise.all([recorded, noted]);
    expect(keys(s)).toEqual([`${HISTORY_BACKLOG_PREFIX}s1`]);
  });
});

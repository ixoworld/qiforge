import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryInvocationStore } from './memory.js';

describe('InMemoryInvocationStore', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('addIfAbsent marks once and refuses a second mark', async () => {
    const store = new InMemoryInvocationStore({ enableAutoCleanup: false });
    expect(await store.addIfAbsent('cid-1')).toBe(true);
    expect(await store.addIfAbsent('cid-1')).toBe(false);
    expect(await store.has('cid-1')).toBe(true);
  });

  it('lets exactly one of many concurrent addIfAbsent calls win', async () => {
    const store = new InMemoryInvocationStore({ enableAutoCleanup: false });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.addIfAbsent('cid-1')),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('delete releases a mark', async () => {
    const store = new InMemoryInvocationStore({ enableAutoCleanup: false });
    await store.addIfAbsent('cid-1');
    await store.delete('cid-1');
    expect(await store.has('cid-1')).toBe(false);
    expect(await store.addIfAbsent('cid-1')).toBe(true);
  });

  it('expires an entry after its own TTL and lets it be marked again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const store = new InMemoryInvocationStore({ enableAutoCleanup: false });

    await store.addIfAbsent('cid-1', 60_000);
    vi.advanceTimersByTime(59_000);
    expect(await store.has('cid-1')).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(await store.has('cid-1')).toBe(false);
    expect(await store.addIfAbsent('cid-1', 60_000)).toBe(true);
  });

  it('never exceeds its cap and evicts the oldest entries first', async () => {
    const store = new InMemoryInvocationStore({
      enableAutoCleanup: false,
      maxEntries: 3,
    });

    for (let i = 0; i < 10; i++) {
      await store.add(`cid-${i}`);
      expect(store.size).toBeLessThanOrEqual(3);
    }
    expect(store.size).toBe(3);
    expect(await store.has('cid-6')).toBe(false);
    expect(await store.has('cid-7')).toBe(true);
    expect(await store.has('cid-9')).toBe(true);
  });

  it('sweeps expired entries before evicting live ones at the cap', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const store = new InMemoryInvocationStore({
      enableAutoCleanup: false,
      maxEntries: 3,
    });

    await store.add('long-lived', 3_600_000);
    await store.add('short-a', 1_000);
    await store.add('short-b', 1_000);
    vi.advanceTimersByTime(5_000);

    await store.addIfAbsent('new', 60_000);

    expect(store.size).toBe(2);
    expect(await store.has('long-lived')).toBe(true);
    expect(await store.has('new')).toBe(true);
  });

  it('refuses a cap that is not a positive integer', () => {
    for (const maxEntries of [0, -1, 1.5, Number.NaN, Infinity]) {
      expect(
        () =>
          new InMemoryInvocationStore({ enableAutoCleanup: false, maxEntries }),
      ).toThrow(RangeError);
    }
  });

  it('sweeps at most once per second while full of live entries', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const store = new InMemoryInvocationStore({
      enableAutoCleanup: false,
      maxEntries: 100,
    });
    for (let i = 0; i < 100; i++) await store.add(`live-${i}`, 3_600_000);

    const scans = vi.spyOn(Map.prototype, 'entries');
    try {
      for (let i = 0; i < 1_000; i++) await store.add(`new-${i}`, 3_600_000);
      expect(scans.mock.calls.length).toBeLessThanOrEqual(1);

      vi.advanceTimersByTime(1_001);
      await store.add('after-interval', 3_600_000);
      expect(scans.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      scans.mockRestore();
    }
    expect(store.size).toBe(100);
  });

  it('sweeps expired entries again once the interval has passed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const store = new InMemoryInvocationStore({
      enableAutoCleanup: false,
      maxEntries: 3,
    });
    await store.add('live-a', 3_600_000);
    await store.add('live-b', 3_600_000);
    await store.add('live-c', 3_600_000);
    // Full of live entries: this insert sweeps (nothing to free) and evicts.
    await store.add('short', 500);
    vi.advanceTimersByTime(2_000);

    await store.add('next', 3_600_000);

    expect(await store.has('live-b')).toBe(true);
    expect(await store.has('live-c')).toBe(true);
    expect(await store.has('next')).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { BoundedMap } from './bounded-map.js';

/** Manually advanced clock so expiry is deterministic. */
function makeClock(start = 0): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('BoundedMap', () => {
  it('stores and retrieves values within the idle TTL', () => {
    const clock = makeClock();
    const map = new BoundedMap<string>({
      maxEntries: 5,
      ttlMs: 100,
      now: clock.now,
    });
    map.set('a', 'A');
    clock.advance(99);
    expect(map.get('a')).toBe('A');
  });

  it('expires entries that idle past the TTL', () => {
    const clock = makeClock();
    const map = new BoundedMap<string>({
      maxEntries: 5,
      ttlMs: 100,
      now: clock.now,
    });
    map.set('a', 'A');
    clock.advance(100);
    expect(map.get('a')).toBeUndefined();
    expect(map.size).toBe(0);
  });

  it('refreshes the idle deadline on read', () => {
    const clock = makeClock();
    const map = new BoundedMap<string>({
      maxEntries: 5,
      ttlMs: 100,
      now: clock.now,
    });
    map.set('a', 'A');
    clock.advance(60);
    expect(map.get('a')).toBe('A');
    clock.advance(60);
    // 120ms since set, but only 60ms since the last read.
    expect(map.get('a')).toBe('A');
  });

  it('evicts the least-recently-used entry beyond the cap', () => {
    const clock = makeClock();
    const map = new BoundedMap<string>({
      maxEntries: 2,
      ttlMs: 1000,
      now: clock.now,
    });
    map.set('a', 'A');
    map.set('b', 'B');
    expect(map.get('a')).toBe('A');
    map.set('c', 'C');
    expect(map.get('b')).toBeUndefined();
    expect(map.get('a')).toBe('A');
    expect(map.get('c')).toBe('C');
  });

  it('deletes and clears', () => {
    const map = new BoundedMap<string>({ maxEntries: 5, ttlMs: 1000 });
    map.set('a', 'A');
    map.set('b', 'B');
    map.delete('a');
    expect(map.get('a')).toBeUndefined();
    map.clear();
    expect(map.size).toBe(0);
  });
});

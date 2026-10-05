import { describe, expect, it } from 'vitest';
import { createMemoryUserKv } from './user-kv';

/** Manually advanced clock so expiry is deterministic. */
function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

describe('createMemoryUserKv', () => {
  it('round-trips JSON values as copies, isolated per namespace', async () => {
    const kv = createMemoryUserKv();
    const value = { a: [1, 2], b: 'x' };
    await kv.set('ns-a', 'k', value);
    value.a.push(3);
    expect(await kv.get('ns-a', 'k')).toEqual({ a: [1, 2], b: 'x' });
    expect(await kv.get('ns-b', 'k')).toBeUndefined();
  });

  it('update is a read-modify-write; returning undefined deletes', async () => {
    const kv = createMemoryUserKv();
    expect(await kv.update('ns', 'n', (c) => (c === undefined ? 1 : c))).toBe(
      1,
    );
    expect(
      await kv.update('ns', 'n', (c) => (typeof c === 'number' ? c + 1 : 0)),
    ).toBe(2);
    expect(await kv.update('ns', 'n', () => undefined)).toBeUndefined();
    expect(await kv.get('ns', 'n')).toBeUndefined();
  });

  it('expires an entry that idles past its TTL; a read slides the deadline', async () => {
    const clock = makeClock();
    const kv = createMemoryUserKv({ now: clock.now });
    await kv.set('ns', 'k', 'v', { idleTtlMs: 100 });
    clock.advance(60);
    expect(await kv.get('ns', 'k')).toBe('v');
    clock.advance(60);
    // 120 ms since the write, 60 ms since the last read.
    expect(await kv.get('ns', 'k')).toBe('v');
    clock.advance(100);
    expect(await kv.get('ns', 'k')).toBeUndefined();
  });

  it('evicts the least recently used entries of the namespace beyond maxEntries', async () => {
    const kv = createMemoryUserKv();
    await kv.set('ns', 'a', 1, { maxEntries: 2 });
    await kv.set('ns', 'b', 2, { maxEntries: 2 });
    await kv.set('other', 'z', 0);
    expect(await kv.get('ns', 'a')).toBe(1);
    await kv.set('ns', 'c', 3, { maxEntries: 2 });
    expect(await kv.get('ns', 'b')).toBeUndefined();
    expect(await kv.get('ns', 'a')).toBe(1);
    expect(await kv.get('ns', 'c')).toBe(3);
    expect(await kv.get('other', 'z')).toBe(0);
  });

  it('rejects what JSON cannot carry and malformed bounds', async () => {
    const kv = createMemoryUserKv();
    await expect(kv.set('ns', 'k', undefined)).rejects.toThrow(/JSON/);
    await expect(kv.set('ns', 'k', () => 1)).rejects.toThrow(/JSON/);
    await expect(kv.set('ns', 'k', 1, { idleTtlMs: 0 })).rejects.toThrow(
      /idleTtlMs/,
    );
    await expect(kv.set('ns', 'k', 1, { maxEntries: 0 })).rejects.toThrow(
      /maxEntries/,
    );
    await expect(kv.get('', 'k')).rejects.toThrow(/namespace/);
  });
});

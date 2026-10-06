import { describe, expect, it } from 'vitest';
import {
  USER_KV_MAX_ENTRIES_PER_NAMESPACE,
  USER_KV_MAX_VALUE_BYTES,
  UserKvLimitError,
  createMemoryUserKv,
} from './user-kv';

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

/** The rejection of `promise`, which must be a `UserKvLimitError`. */
async function limitError(
  promise: Promise<unknown>,
): Promise<UserKvLimitError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof UserKvLimitError)) {
    throw new Error(`expected a UserKvLimitError, got ${String(error)}`);
  }
  return error;
}

/** A JSON string value whose stored form is exactly `bytes` long. */
const jsonOfBytes = (bytes: number): string => 'x'.repeat(bytes - 2);

describe('createMemoryUserKv hard caps', () => {
  it('refuses a value above the byte cap, counting UTF-8 bytes of the JSON', async () => {
    const kv = createMemoryUserKv();
    await kv.set('ns', 'at-cap', jsonOfBytes(USER_KV_MAX_VALUE_BYTES));
    expect(await kv.get('ns', 'at-cap')).toHaveLength(
      USER_KV_MAX_VALUE_BYTES - 2,
    );
    const error = await limitError(
      kv.set('ns', 'over', jsonOfBytes(USER_KV_MAX_VALUE_BYTES + 1)),
    );
    expect(error).toMatchObject({
      name: 'UserKvLimitError',
      limit: 'value',
      namespace: 'ns',
      max: USER_KV_MAX_VALUE_BYTES,
      actual: USER_KV_MAX_VALUE_BYTES + 1,
    });
    expect(error.message).toContain('"ns"');
    expect(await kv.get('ns', 'over')).toBeUndefined();
    // Two bytes per character: fewer characters than the cap, more bytes.
    const wide = 'é'.repeat(USER_KV_MAX_VALUE_BYTES / 2);
    expect((await limitError(kv.set('ns', 'wide', wide))).actual).toBe(
      USER_KV_MAX_VALUE_BYTES + 2,
    );
  });

  it('rejects a maxEntries above the per-namespace cap instead of clamping it', async () => {
    const kv = createMemoryUserKv();
    await kv.set('ns', 'k', 1, {
      maxEntries: USER_KV_MAX_ENTRIES_PER_NAMESPACE,
    });
    await expect(
      kv.set('ns', 'k', 1, {
        maxEntries: USER_KV_MAX_ENTRIES_PER_NAMESPACE + 1,
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      kv.update('ns', 'k', () => 2, { maxEntries: 4 }),
    ).resolves.toBe(2);
    const small = createMemoryUserKv({ limits: { maxEntriesPerNamespace: 3 } });
    await expect(
      small.update('ns', 'k', () => 2, { maxEntries: 4 }),
    ).rejects.toThrow(/at most 3/);
  });

  it('refuses a new key beyond the namespace cap; replacing a key at the cap succeeds', async () => {
    const kv = createMemoryUserKv({ limits: { maxEntriesPerNamespace: 3 } });
    for (const key of ['a', 'b', 'c']) await kv.set('ns', key, key);
    const error = await limitError(kv.set('ns', 'd', 'd'));
    expect(error).toMatchObject({
      limit: 'namespace-entries',
      namespace: 'ns',
      max: 3,
      actual: 4,
    });
    expect(await kv.get('ns', 'd')).toBeUndefined();
    await kv.set('ns', 'a', 'replaced');
    expect(await kv.get('ns', 'a')).toBe('replaced');
    await kv.set('other', 'd', 'd');
    // A write whose own maxEntries trim makes room is not refused.
    await kv.set('ns', 'd', 'd', { maxEntries: 3 });
    expect(await kv.get('ns', 'd')).toBe('d');
  });

  it('refuses a new key beyond the total-entries cap across namespaces', async () => {
    const kv = createMemoryUserKv({ limits: { maxTotalEntries: 3 } });
    await kv.set('ns-a', 'a1', 1);
    await kv.set('ns-a', 'a2', 2);
    await kv.set('ns-b', 'b1', 3);
    const error = await limitError(kv.update('ns-b', 'b2', () => 4));
    expect(error).toMatchObject({
      limit: 'entries',
      namespace: 'ns-b',
      max: 3,
      actual: 4,
    });
    await kv.delete('ns-a', 'a1');
    await kv.set('ns-b', 'b2', 4);
    expect(await kv.get('ns-b', 'b2')).toBe(4);
  });

  it('counts only the size difference when a key is replaced', async () => {
    // A row counts namespace + key + value JSON: each row below carries 5
    // bytes of names ('ns-a' + 'a'), and every value is a JSON string (two
    // quote bytes plus its letters).
    const kv = createMemoryUserKv({ limits: { maxTotalBytes: 30 } });
    await kv.set('ns-a', 'a', 'aaaaaaaa'); // 5 + 10 = 15 bytes
    await kv.set('ns-b', 'b', 'bbbbbbbb'); // 15 bytes, total 30
    await kv.set('ns-a', 'a', 'AAAAAAAA'); // same size: 30
    await kv.set('ns-a', 'a', 'aa'); // shrinks: 24
    await kv.set('ns-b', 'b', 'bbbbbbbbbbbbbb'); // grows by 6: 30
    const error = await limitError(kv.set('ns-a', 'a', 'aaa'));
    expect(error).toMatchObject({
      limit: 'bytes',
      namespace: 'ns-a',
      max: 30,
      actual: 31,
    });
    expect(await kv.get('ns-a', 'a')).toBe('aa');
  });

  it('sweeps expired entries of every namespace before refusing', async () => {
    const clock = makeClock();
    const kv = createMemoryUserKv({
      now: clock.now,
      limits: { maxTotalEntries: 2 },
    });
    await kv.set('ns-a', 'a1', 1, { idleTtlMs: 100 });
    await kv.set('ns-a', 'a2', 2, { idleTtlMs: 100 });
    await expect(kv.set('ns-b', 'b1', 3)).rejects.toThrow(UserKvLimitError);
    clock.advance(100);
    await kv.set('ns-b', 'b1', 3);
    await kv.set('ns-b', 'b2', 4);
    expect(await kv.get('ns-b', 'b1')).toBe(3);
    expect(await kv.get('ns-a', 'a1')).toBeUndefined();
  });

  it('a refused write changes nothing: the previous value stays and its trim is undone', async () => {
    const kv = createMemoryUserKv({ limits: { maxTotalBytes: 30 } });
    await kv.set('ns', 'a', 'aaaaaaaa', { maxEntries: 2 }); // 3 + 10 bytes
    await kv.set('ns', 'b', 'bbbbbbbb', { maxEntries: 2 }); // 3 + 10 bytes
    // The write's trim would evict `a`, but 13 + (3 + 25) bytes is still over.
    const big = jsonOfBytes(25);
    await expect(kv.set('ns', 'c', big, { maxEntries: 2 })).rejects.toThrow(
      UserKvLimitError,
    );
    expect(await kv.get('ns', 'c')).toBeUndefined();
    expect(await kv.get('ns', 'a')).toBe('aaaaaaaa');
    expect(await kv.get('ns', 'b')).toBe('bbbbbbbb');
    await expect(kv.update('ns', 'b', () => big)).rejects.toThrow(
      UserKvLimitError,
    );
    expect(await kv.get('ns', 'b')).toBe('bbbbbbbb');
  });

  it('counts namespace and key bytes toward the store-wide byte cap', async () => {
    const kv = createMemoryUserKv({ limits: { maxTotalBytes: 50 } });
    await kv.set('ns', 'k', 1); // 2 + 1 + 1 = 4 bytes
    // A 1-byte value under a 100-character key: 2 + 100 + 1 bytes.
    const longKey = 'k'.repeat(100);
    const error = await limitError(kv.set('ns', longKey, 1));
    expect(error).toMatchObject({
      limit: 'bytes',
      namespace: 'ns',
      max: 50,
      actual: 4 + 103,
    });
    expect(error.message).toContain('namespace, key and value');
    expect(await kv.get('ns', longKey)).toBeUndefined();
  });
});

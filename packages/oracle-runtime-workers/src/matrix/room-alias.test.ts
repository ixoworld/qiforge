import { describe, expect, it } from 'vitest';
import { VerifiedRoomAliases } from './room-alias';

const ALIAS = '#did-ixo-ixo1u_did-ixo-ixo1o:ixo.test';

function harness(
  opts: {
    claimed?: string | null;
    directory?: Record<string, string>;
    failResolve?: number;
  } = {},
) {
  let now = 1_000;
  let failures = opts.failResolve ?? 0;
  const calls = { read: 0, resolve: 0 };
  let pendingResolve: ((room: string | null) => void) | null = null;
  const verifier = new VerifiedRoomAliases({
    readCanonicalAlias: async () => {
      calls.read += 1;
      return opts.claimed === undefined ? ALIAS : opts.claimed;
    },
    resolveAlias: async (alias) => {
      calls.resolve += 1;
      if (failures > 0) {
        failures -= 1;
        throw new Error('502');
      }
      if (opts.directory === undefined)
        return new Promise((r) => {
          pendingResolve = r;
        });
      return opts.directory[alias] ?? null;
    },
    ttlMs: 60_000,
    maxRooms: 2,
    now: () => now,
  });
  return {
    verifier,
    calls,
    tick: (ms: number) => {
      now += ms;
    },
    settle: (room: string | null) => pendingResolve?.(room),
  };
}

describe('VerifiedRoomAliases', () => {
  it('accepts an alias only when its server resolves it to the same room', async () => {
    const h = harness({ directory: { [ALIAS]: '!a:ixo.test' } });
    expect(await h.verifier.verify('!a:ixo.test')).toBe(ALIAS);
    expect(await h.verifier.verify('!b:ixo.test')).toBeNull();
    expect(h.verifier.known('!a:ixo.test')).toBe(ALIAS);
    expect(h.verifier.known('!b:ixo.test')).toBeNull();
  });

  it('a room without an alias of this oracle is not looked up in the directory', async () => {
    const h = harness({ claimed: null, directory: {} });
    expect(await h.verifier.verify('!a:ixo.test')).toBeNull();
    expect(h.calls.resolve).toBe(0);
  });

  it('memoises verdicts for the TTL, then asks again', async () => {
    const h = harness({ directory: { [ALIAS]: '!a:ixo.test' } });
    await h.verifier.verify('!a:ixo.test');
    await h.verifier.verify('!a:ixo.test');
    expect(h.calls.resolve).toBe(1);
    h.tick(60_000);
    expect(h.verifier.known('!a:ixo.test')).toBeNull();
    await h.verifier.verify('!a:ixo.test');
    expect(h.calls.resolve).toBe(2);
  });

  it('a failed lookup throws and memoises nothing', async () => {
    const h = harness({
      directory: { [ALIAS]: '!a:ixo.test' },
      failResolve: 1,
    });
    await expect(h.verifier.verify('!a:ixo.test')).rejects.toThrow('502');
    expect(h.verifier.known('!a:ixo.test')).toBeNull();
    expect(await h.verifier.verify('!a:ixo.test')).toBe(ALIAS);
  });

  it('a lookup that started before an invalidation is not memoised after it', async () => {
    const h = harness();
    const pending = h.verifier.verify('!a:ixo.test');
    await Promise.resolve();
    await Promise.resolve();
    h.verifier.invalidate('!a:ixo.test');
    h.settle('!a:ixo.test');
    expect(await pending).toBe(ALIAS);
    expect(h.verifier.known('!a:ixo.test')).toBeNull();
  });

  it('remembers a bounded number of rooms, dropping the oldest', async () => {
    const h = harness({
      directory: { [ALIAS]: '!a:ixo.test' },
    });
    await h.verifier.verify('!a:ixo.test');
    await h.verifier.verify('!b:ixo.test');
    await h.verifier.verify('!c:ixo.test');
    expect(h.calls.resolve).toBe(3);
    await h.verifier.verify('!a:ixo.test');
    expect(h.calls.resolve).toBe(4);
  });
});

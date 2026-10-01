import { describe, expect, it } from 'vitest';
import { freshStub } from './fresh-stub';

interface FakeStub {
  incarnation: number;
  ping(): string;
  add(a: number, b: number): number;
}

describe('freshStub', () => {
  it('routes every property access to a newly obtained stub', () => {
    // RPC properties are self-contained (they carry their own target), so
    // the fake's methods close over their incarnation instead of using `this`.
    let created = 0;
    const make = (): FakeStub => {
      created += 1;
      const mine = created;
      return {
        incarnation: mine,
        ping: () => `pong from ${mine}`,
        add: (a, b) => a + b,
      };
    };
    const proxy = freshStub(make);
    expect(proxy.ping()).toBe('pong from 1');
    expect(proxy.ping()).toBe('pong from 2');
    expect(proxy.add(2, 3)).toBe(5);
    expect(proxy.incarnation).toBe(4);
    expect('ping' in proxy).toBe(true);
    expect(created).toBe(5);
  });

  it('returns RPC properties untouched (no bind — the runtime treats that as an RPC call)', () => {
    const marker = () => 'rpc';
    const proxy = freshStub<{ incarnation: number; rpc: () => string }>(() => ({
      incarnation: 1,
      rpc: marker,
    }));
    expect(proxy.rpc).toBe(marker);
    expect(proxy.rpc()).toBe('rpc');
  });
});

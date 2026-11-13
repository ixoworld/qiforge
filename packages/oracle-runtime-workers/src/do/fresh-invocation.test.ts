import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FreshInvocationGate,
  isLoopLimitError,
  withLoopLimitRetry,
} from './fresh-invocation';

const REFUSAL =
  'Subrequest depth limit exceeded. This request looped back into the Workers runtime too many times.';

function makeGate(opts: { armFails?: boolean; timeoutMs?: number } = {}) {
  const kept: Array<Promise<unknown>> = [];
  const warnings: string[] = [];
  let arms = 0;
  const gate = new FreshInvocationGate({
    armNow: async () => {
      arms += 1;
      if (opts.armFails) throw new Error('storage down');
    },
    keepAlive: (work) => kept.push(work),
    warn: (m) => warnings.push(m),
    timeoutMs: opts.timeoutMs ?? 3000,
    maxLeaseMs: 60_000,
  });
  return { gate, kept, warnings, arms: () => arms };
}

describe('isLoopLimitError', () => {
  it('matches the refusal, also as a cause or a string', () => {
    expect(isLoopLimitError(new Error(REFUSAL))).toBe(true);
    expect(
      isLoopLimitError(
        new Error('model call failed', { cause: new Error(REFUSAL) }),
      ),
    ).toBe(true);
    expect(isLoopLimitError(REFUSAL)).toBe(true);
    expect(isLoopLimitError(new Error('Network connection lost'))).toBe(false);
    expect(isLoopLimitError(undefined)).toBe(false);
  });
});

describe('FreshInvocationGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds the caller until the alarm releases it, then keeps the alarm open until the lease ends', async () => {
    const { gate, kept, arms } = makeGate();
    let lease: Awaited<ReturnType<typeof gate.enter>> | undefined;
    const entered = gate.enter('room turn r1').then((l) => {
      lease = l;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(arms()).toBe(1);
    expect(gate.pending).toBe(1);
    expect(lease).toBeUndefined();

    expect(gate.release()).toBe(1);
    await entered;
    expect(lease?.fresh).toBe(true);
    expect(gate.pending).toBe(0);
    expect(kept).toHaveLength(1);

    let held = true;
    void kept[0]!.then(() => {
      held = false;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(held).toBe(true);
    lease!.end();
    lease!.end(); // idempotent
    await vi.advanceTimersByTimeAsync(0);
    expect(held).toBe(false);
  });

  it('releases every waiter with one alarm', async () => {
    const { gate, kept } = makeGate();
    const a = gate.enter('a');
    const b = gate.enter('b');
    await vi.advanceTimersByTimeAsync(0);
    expect(gate.release()).toBe(2);
    expect((await a).fresh).toBe(true);
    expect((await b).fresh).toBe(true);
    expect(kept).toHaveLength(2);
    expect(gate.release()).toBe(0);
  });

  it('carries on in place (not fresh) when no alarm arrives in time, and a late alarm releases nobody', async () => {
    const { gate, kept, warnings } = makeGate({ timeoutMs: 3000 });
    const entered = gate.enter('room turn r2');
    await vi.advanceTimersByTimeAsync(3000);
    const lease = await entered;
    expect(lease.fresh).toBe(false);
    expect(warnings.join('\n')).toMatch(
      /no alarm within 3000 ms for room turn r2/,
    );
    expect(gate.release()).toBe(0);
    expect(kept).toHaveLength(0);
    lease.end();
  });

  it('carries on in place when the alarm cannot be armed', async () => {
    const { gate, warnings } = makeGate({ armFails: true });
    const lease = await gate.enter('status card r3');
    expect(lease.fresh).toBe(false);
    expect(gate.pending).toBe(0);
    expect(warnings.join('\n')).toMatch(/could not arm the alarm/);
  });

  it('a lease never ended stops holding the alarm after the cap', async () => {
    const { gate, kept, warnings } = makeGate();
    const entered = gate.enter('forgotten');
    await vi.advanceTimersByTimeAsync(0);
    gate.release();
    await entered;
    let held = true;
    void kept[0]!.then(() => {
      held = false;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(held).toBe(false);
    expect(warnings.join('\n')).toMatch(/held over 60 s/);
  });
});

describe('withLoopLimitRetry', () => {
  function handle(failures: number, error: unknown = new Error(REFUSAL)) {
    let calls = 0;
    const target = {
      sendEvent: async (room: string) => {
        calls += 1;
        if (calls <= failures) throw error;
        return `$event-in-${room}`;
      },
      upload: async (_stream: ReadableStream) => {
        calls += 1;
        throw new Error(REFUSAL);
      },
    };
    return { target, calls: () => calls };
  }
  function refresher() {
    const labels: string[] = [];
    let ended = 0;
    return {
      labels,
      ended: () => ended,
      refresh: async (label: string) => {
        labels.push(label);
        return {
          fresh: true,
          end: () => {
            ended += 1;
          },
        };
      },
    };
  }

  it('retries a refused call once from a fresh invocation', async () => {
    const { target, calls } = handle(1);
    const r = refresher();
    const warnings: string[] = [];
    const wrapped = withLoopLimitRetry(target, {
      name: 'gateway',
      refresh: r.refresh,
      warn: (m) => warnings.push(m),
    });
    await expect(wrapped.sendEvent('!r')).resolves.toBe('$event-in-!r');
    expect(calls()).toBe(2);
    expect(r.labels).toEqual(['gateway.sendEvent retry']);
    expect(r.ended()).toBe(1);
    expect(warnings[0]).toMatch(
      /\[loop-limit\] gateway\.sendEvent was refused/,
    );
  });

  it('gives up after the one retry', async () => {
    const { target, calls } = handle(5);
    const r = refresher();
    const wrapped = withLoopLimitRetry(target, {
      name: 'gateway',
      refresh: r.refresh,
      warn: () => undefined,
    });
    await expect(wrapped.sendEvent('!r')).rejects.toThrow(/Subrequest depth/);
    expect(calls()).toBe(2);
    expect(r.ended()).toBe(1);
  });

  it('does not retry other errors or calls that carry a stream', async () => {
    const other = handle(1, new Error('Network connection lost'));
    const r = refresher();
    const wrapped = withLoopLimitRetry(other.target, {
      name: 'gateway',
      refresh: r.refresh,
      warn: () => undefined,
    });
    await expect(wrapped.sendEvent('!r')).rejects.toThrow(
      /Network connection lost/,
    );
    expect(other.calls()).toBe(1);
    await expect(wrapped.upload(new ReadableStream())).rejects.toThrow(
      /Subrequest depth/,
    );
    expect(other.calls()).toBe(2);
    expect(r.labels).toEqual([]);
  });
});

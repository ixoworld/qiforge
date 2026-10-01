import { describe, expect, it } from 'vitest';
import {
  framesOfSegments,
  partialTextOf,
  RunBuffer,
  type PackedSegment,
  type RunFrame,
} from './run-buffer';

function fakeTimers() {
  const pending = new Map<number, () => void>();
  let id = 0;
  return {
    setTimer: (fn: () => void) => {
      const handle = ++id;
      pending.set(handle, fn);
      return handle;
    },
    clearTimer: (handle: unknown) => {
      pending.delete(handle as number);
    },
    fire: () => {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    get armed() {
      return pending.size;
    },
  };
}

function buffer(
  overrides: Partial<ConstructorParameters<typeof RunBuffer>[0]> = {},
) {
  const packed: PackedSegment[] = [];
  const timers = fakeTimers();
  const buf = new RunBuffer({
    flushMs: 1000,
    flushBytes: 10_000,
    immediate: (event) => event === 'tool_call',
    onPack: (segment) => {
      packed.push(segment);
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...overrides,
  });
  return { buf, packed, timers };
}

describe('RunBuffer', () => {
  it('numbers frames from 1 and fans them out to subscribers', () => {
    const { buf } = buffer();
    const seen: RunFrame[] = [];
    buf.subscribe((frame) => seen.push(frame));
    buf.push('message', { content: 'a' });
    buf.push('message', { content: 'b' });
    expect(seen.map((f) => f.seq)).toEqual([1, 2]);
    expect(buf.lastSeq).toBe(2);
  });

  it('packs the tail on the timer, on the byte cap, and at once for immediate events', async () => {
    const { buf, packed, timers } = buffer({ flushBytes: 120 });
    buf.push('message', { content: 'hello' });
    expect(packed).toHaveLength(0);
    expect(timers.armed).toBe(1);
    timers.fire();
    await buf.flush();
    expect(packed).toHaveLength(1);
    expect(packed[0]).toMatchObject({ seqFrom: 1, seqTo: 1 });

    // Byte cap: a big frame packs without waiting for the timer.
    buf.push('message', { content: 'x'.repeat(200) });
    await buf.flush();
    expect(packed).toHaveLength(2);
    expect(packed[1]).toMatchObject({ seqFrom: 2, seqTo: 2 });

    // Immediate: a settled tool result must not wait either.
    buf.push('message', { content: 'y' });
    buf.push('tool_call', { toolName: 't', status: 'done' });
    await buf.flush();
    expect(packed).toHaveLength(3);
    expect(packed[2]).toMatchObject({ seqFrom: 3, seqTo: 4 });
    expect(buf.packedSeq).toBe(4);
    expect(timers.armed).toBe(0);
  });

  it('serves a re-join from segments plus the unflushed tail after a cursor', async () => {
    const { buf, packed, timers } = buffer();
    buf.push('message', { content: 'one ' });
    buf.push('message', { content: 'two ' });
    timers.fire();
    await buf.flush();
    buf.push('message', { content: 'three' });
    // A client that saw seq 1 re-joins: it reads the store, then the tail.
    const replay = [...framesOfSegments(packed, 1), ...buf.tailAfter(1)];
    expect(replay.map((f) => f.seq)).toEqual([2, 3]);
    expect(
      partialTextOf([...framesOfSegments(packed), ...buf.tailAfter(2)]),
    ).toBe('one two three');
  });

  it('close packs what is left and drops subscribers', async () => {
    const { buf, packed } = buffer();
    const unsubscribe = buf.subscribe(() => undefined);
    buf.push('done', {});
    await buf.close();
    expect(packed).toHaveLength(1);
    expect(buf.isClosed).toBe(true);
    expect(buf.subscriberCount).toBe(0);
    expect(() => buf.push('message', {})).toThrow(/closed/);
    unsubscribe();
  });

  it('reports a failed pack and keeps the run going', async () => {
    const errors: unknown[] = [];
    const { buf } = buffer({
      onPack: () => {
        throw new Error('disk');
      },
      onPackError: (error) => errors.push(error),
    });
    buf.push('tool_call', {});
    await buf.flush();
    expect(errors).toHaveLength(1);
    buf.push('message', { content: 'still streaming' });
    expect(buf.lastSeq).toBe(2);
  });
});

import { describe, expect, it } from 'vitest';
import { ToolScheduler } from './tool-scheduler';

/** A task that reports when it started and finishes on demand. */
function gate() {
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { done, release };
}

const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('ToolScheduler', () => {
  it('runs writes one at a time, in order', async () => {
    const scheduler = new ToolScheduler();
    const order: string[] = [];
    const first = gate();
    const a = scheduler.run('write', undefined, async () => {
      order.push('a:start');
      await first.done;
      order.push('a:end');
    });
    const b = scheduler.run('write', undefined, async () => {
      order.push('b:start');
    });
    await settled();
    expect(order).toEqual(['a:start']);
    expect(scheduler.snapshot().write).toEqual({ inFlight: 1, queued: 1 });
    first.release();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('bounds reads and sub-agents in separate lanes', async () => {
    const scheduler = new ToolScheduler({ maxReads: 2, maxSubagents: 1 });
    const gates = [gate(), gate(), gate()];
    let started = 0;
    const reads = gates.map((g) =>
      scheduler.run('read', undefined, async () => {
        started += 1;
        await g.done;
      }),
    );
    const child = gate();
    let childStarted = false;
    const dispatch = scheduler.run('subagent', undefined, async () => {
      childStarted = true;
      await child.done;
    });
    await settled();
    expect(started).toBe(2);
    expect(childStarted).toBe(true);
    expect(scheduler.snapshot()).toEqual({
      read: { inFlight: 2, queued: 1 },
      write: { inFlight: 0, queued: 0 },
      subagent: { inFlight: 1, queued: 0 },
    });
    gates[0]!.release();
    await settled();
    expect(started).toBe(3);
    gates[1]!.release();
    gates[2]!.release();
    child.release();
    await Promise.all([...reads, dispatch]);
    expect(scheduler.snapshot().read).toEqual({ inFlight: 0, queued: 0 });
  });

  it('lets an aborted turn leave the queue without taking the slot', async () => {
    const scheduler = new ToolScheduler();
    const holder = gate();
    const held = scheduler.run('write', undefined, () => holder.done);
    const controller = new AbortController();
    let ran = false;
    const waiting = scheduler.run('write', controller.signal, async () => {
      ran = true;
    });
    await settled();
    const reason = new Error('turn superseded');
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    expect(scheduler.snapshot().write.queued).toBe(0);
    holder.release();
    await held;
    await settled();
    expect(ran).toBe(false);
    expect(scheduler.snapshot().write).toEqual({ inFlight: 0, queued: 0 });
  });

  it('refuses to start on an already aborted signal', async () => {
    const scheduler = new ToolScheduler();
    const controller = new AbortController();
    controller.abort();
    await expect(
      scheduler.run('read', controller.signal, async () => 'never'),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('releases the slot when the action throws', async () => {
    const scheduler = new ToolScheduler();
    await expect(
      scheduler.run('write', undefined, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(scheduler.snapshot().write).toEqual({ inFlight: 0, queued: 0 });
    await expect(
      scheduler.run('write', undefined, async () => 'next'),
    ).resolves.toBe('next');
  });
});

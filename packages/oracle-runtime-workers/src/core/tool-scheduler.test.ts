import { describe, expect, it, vi } from 'vitest';
import { sessionLaneKey, ToolScheduler } from './tool-scheduler';

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
    const dispatch = scheduler.run(
      'subagent',
      undefined,
      async () => {
        childStarted = true;
        await child.done;
      },
      's1',
    );
    await settled();
    expect(started).toBe(2);
    expect(childStarted).toBe(true);
    expect(scheduler.snapshot()).toEqual({
      read: { inFlight: 2, queued: 1 },
      write: { inFlight: 0, queued: 0 },
      frontend: { inFlight: 0, queued: 0 },
      subagent: { inFlight: 1, queued: 0 },
      sessionLanes: { 'subagent:s1': { inFlight: 1, queued: 0 } },
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

  it('removes the abort listener of a waiter once it gets the slot', async () => {
    const scheduler = new ToolScheduler();
    const holder = gate();
    const held = scheduler.run('write', undefined, () => holder.done);
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const waiting = scheduler.run(
      'write',
      controller.signal,
      async () => 'ran',
    );
    await settled();
    expect(add).toHaveBeenCalledOnce();
    holder.release();
    await held;
    await expect(waiting).resolves.toBe('ran');
    // The listener added while waiting is the one removed at hand-off: the
    // turn's signal keeps no reference to a call that already ran.
    expect(remove).toHaveBeenCalledOnce();
    expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
  });

  describe('per-session lanes', () => {
    it('keys a session lane by kind and session id', () => {
      expect(sessionLaneKey('frontend', 's1')).toBe('frontend:s1');
      expect(sessionLaneKey('subagent', 's1')).toBe('subagent:s1');
    });

    it('runs frontend calls one at a time per session, sessions side by side, beside the user-wide lanes', async () => {
      const scheduler = new ToolScheduler();
      const order: string[] = [];
      const userWrite = gate();
      const sessionA = gate();
      const runs = [
        scheduler.run('write', undefined, async () => {
          order.push('write:start');
          await userWrite.done;
        }),
        scheduler.run(
          'frontend',
          undefined,
          async () => {
            order.push('a1:start');
            await sessionA.done;
          },
          'a',
        ),
        scheduler.run(
          'frontend',
          undefined,
          async () => {
            order.push('a2:start');
          },
          'a',
        ),
        scheduler.run(
          'frontend',
          undefined,
          async () => {
            order.push('b:start');
          },
          'b',
        ),
      ];
      await settled();
      // frontend:b ran to completion beside the held write and frontend:a.
      expect(order).toEqual(['write:start', 'a1:start', 'b:start']);
      expect(scheduler.snapshot()).toMatchObject({
        write: { inFlight: 1, queued: 0 },
        frontend: { inFlight: 1, queued: 1 },
        sessionLanes: { 'frontend:a': { inFlight: 1, queued: 1 } },
      });
      sessionA.release();
      await settled();
      expect(order).toEqual(['write:start', 'a1:start', 'b:start', 'a2:start']);
      userWrite.release();
      await Promise.all(runs);
      expect(scheduler.snapshot().sessionLanes).toEqual({});
    });

    it('never lets parked frontend calls hold a user-wide slot', async () => {
      const scheduler = new ToolScheduler({ maxReads: 4 });
      const parked = gate();
      // Four chats, each with a browser read waiting for its tab.
      const frontend = ['s1', 's2', 's3', 's4'].map((sessionId) =>
        scheduler.run('frontend', undefined, () => parked.done, sessionId),
      );
      await settled();
      expect(scheduler.snapshot().frontend).toEqual({
        inFlight: 4,
        queued: 0,
      });
      await expect(
        scheduler.run('read', undefined, async () => 'read'),
      ).resolves.toBe('read');
      await expect(
        scheduler.run('write', undefined, async () => 'write'),
      ).resolves.toBe('write');
      parked.release();
      await Promise.all(frontend);
    });

    it('bounds sub-agent dispatches per session, so one chat never holds another chat’s slots', async () => {
      const scheduler = new ToolScheduler({ maxSubagents: 1 });
      const held = gate();
      const a1 = scheduler.run('subagent', undefined, () => held.done, 'a');
      let a2Ran = false;
      const a2 = scheduler.run(
        'subagent',
        undefined,
        async () => {
          a2Ran = true;
        },
        'a',
      );
      await expect(
        scheduler.run('subagent', undefined, async () => 'b', 'b'),
      ).resolves.toBe('b');
      expect(a2Ran).toBe(false);
      expect(scheduler.snapshot()).toMatchObject({
        subagent: { inFlight: 1, queued: 1 },
        sessionLanes: { 'subagent:a': { inFlight: 1, queued: 1 } },
      });
      held.release();
      await Promise.all([a1, a2]);
      expect(a2Ran).toBe(true);
      expect(scheduler.snapshot().sessionLanes).toEqual({});
    });

    it('removes a lane once it is idle, whether the action resolved or threw', async () => {
      const scheduler = new ToolScheduler();
      await scheduler.run('frontend', undefined, async () => 'ok', 'a');
      await expect(
        scheduler.run(
          'frontend',
          undefined,
          async () => {
            throw new Error('boom');
          },
          'b',
        ),
      ).rejects.toThrow('boom');
      expect(scheduler.snapshot()).toMatchObject({
        frontend: { inFlight: 0, queued: 0 },
        sessionLanes: {},
      });
    });

    it('keeps a lane while a waiter holds it and removes it after the last one', async () => {
      const scheduler = new ToolScheduler();
      const first = gate();
      const a = scheduler.run('frontend', undefined, () => first.done, 'a');
      const b = scheduler.run('frontend', undefined, async () => 'second', 'a');
      await settled();
      first.release();
      await a;
      // The slot passed straight to the waiter; the lane is gone once it ends.
      await expect(b).resolves.toBe('second');
      expect(scheduler.snapshot().sessionLanes).toEqual({});
    });

    it('lets an aborted waiter leave a session lane without holding it', async () => {
      const scheduler = new ToolScheduler();
      const holder = gate();
      const held = scheduler.run('frontend', undefined, () => holder.done, 'a');
      const controller = new AbortController();
      let ran = false;
      const waiting = scheduler.run(
        'frontend',
        controller.signal,
        async () => {
          ran = true;
        },
        'a',
      );
      await settled();
      expect(scheduler.snapshot().sessionLanes['frontend:a']).toEqual({
        inFlight: 1,
        queued: 1,
      });
      const reason = new Error('turn superseded');
      controller.abort(reason);
      await expect(waiting).rejects.toBe(reason);
      expect(scheduler.snapshot().sessionLanes['frontend:a']).toEqual({
        inFlight: 1,
        queued: 0,
      });
      holder.release();
      await held;
      expect(ran).toBe(false);
      expect(scheduler.snapshot().sessionLanes).toEqual({});
    });

    it('creates no lane for a signal already aborted', async () => {
      const scheduler = new ToolScheduler();
      const controller = new AbortController();
      controller.abort();
      await expect(
        scheduler.run('frontend', controller.signal, async () => 'never', 'a'),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(scheduler.snapshot().sessionLanes).toEqual({});
    });

    it('needs the session id for a session lane, and ignores it for the user-wide lanes', async () => {
      const scheduler = new ToolScheduler();
      await expect(
        scheduler.run('frontend', undefined, async () => 'never'),
      ).rejects.toThrow(TypeError);
      await expect(
        scheduler.run('read', undefined, async () => 'read', 'a'),
      ).resolves.toBe('read');
      expect(scheduler.snapshot().sessionLanes).toEqual({});
    });
  });
});

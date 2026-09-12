import { describe, expect, it, vi } from 'vitest';
import { ACTION_LOG_EVENT_TYPE, logActionToMatrix } from './action-log';

const transient = () => new Error('Network connection lost');

function ctxWith(postEvent: (...args: unknown[]) => Promise<string>) {
  const kept: Promise<unknown>[] = [];
  const warn = vi.fn();
  const ctx = {
    matrix: { postEvent } as never,
    session: { id: '$sess', roomId: '!room' } as never,
    logger: { log: vi.fn(), warn, error: vi.fn() } as never,
    background: (w: Promise<unknown>) => {
      kept.push(w);
    },
  };
  return { ctx, kept, warn };
}

const action = {
  name: 'navigate',
  args: { to: '/x' },
  result: 'ok',
  success: true,
};

describe('logActionToMatrix', () => {
  it('posts the event once and hands the work to the host to keep alive', async () => {
    const postEvent = vi.fn().mockResolvedValue('$ev');
    const { ctx, kept } = ctxWith(postEvent);
    logActionToMatrix(ctx, action, {
      delaysMs: [1],
      sleep: async () => undefined,
    });
    expect(kept).toHaveLength(1);
    await kept[0];
    expect(postEvent).toHaveBeenCalledOnce();
    expect(postEvent.mock.calls[0]?.[1]).toBe(ACTION_LOG_EVENT_TYPE);
    expect(postEvent.mock.calls[0]?.[2]).toEqual({ action, threadId: '$sess' });
    expect(postEvent.mock.calls[0]?.[3]).toEqual({
      txnId: expect.stringMatching(/^action-log-[0-9a-f-]{36}$/),
    });
  });

  it('gives every entry its own transaction id', async () => {
    const postEvent = vi.fn().mockResolvedValue('$ev');
    const { ctx, kept } = ctxWith(postEvent);
    logActionToMatrix(ctx, action);
    logActionToMatrix(ctx, { ...action, name: 'click' });
    await Promise.all(kept);
    expect(postEvent.mock.calls[0]?.[3]).not.toEqual(
      postEvent.mock.calls[1]?.[3],
    );
  });

  it('retries a transient gateway failure; the entry lands once', async () => {
    const postEvent = vi
      .fn()
      .mockRejectedValueOnce(transient())
      .mockResolvedValue('$ev');
    const { ctx, kept, warn } = ctxWith(postEvent);
    logActionToMatrix(ctx, action, {
      delaysMs: [1, 1],
      sleep: async () => undefined,
    });
    await kept[0];
    expect(postEvent).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce(); // the retry line
    // The retry re-sends under the same transaction id.
    expect(postEvent.mock.calls[1]?.[3]).toEqual(postEvent.mock.calls[0]?.[3]);
  });

  it('logs and gives up on a non-transient failure', async () => {
    const postEvent = vi.fn().mockRejectedValue(new Error('M_FORBIDDEN'));
    const { ctx, kept, warn } = ctxWith(postEvent);
    logActionToMatrix(ctx, action, {
      delaysMs: [1, 1],
      sleep: async () => undefined,
    });
    await kept[0];
    expect(postEvent).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('not posted');
  });

  it('does nothing without a room', () => {
    const postEvent = vi.fn();
    const { ctx, kept } = ctxWith(postEvent);
    logActionToMatrix({ ...ctx, session: { id: '$sess' } as never }, action);
    expect(postEvent).not.toHaveBeenCalled();
    expect(kept).toHaveLength(0);
  });
});

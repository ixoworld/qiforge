import { describe, expect, it, vi } from 'vitest';
import { mirrorTxnId, RoomMirror, type MirrorSend } from './room-mirror';

const transient = () => new Error('Network connection lost');
const fast = { delaysMs: [1, 1, 1], sleep: async () => undefined };

function harness(sendText: (s: MirrorSend) => Promise<string>) {
  const kept: Promise<unknown>[] = [];
  const log = vi.fn();
  const warn = vi.fn();
  const mirror = new RoomMirror({
    sendText,
    keepAlive: (w) => kept.push(w),
    log,
    warn,
    retry: fast,
  });
  return { mirror, kept, log, warn };
}

const send = (threadId: string, body: string, txnId: string): MirrorSend => ({
  roomId: '!room',
  body,
  threadId,
  txnId,
});

describe('mirrorTxnId', () => {
  it('is fixed per session, request and author', () => {
    expect(mirrorTxnId('$s', 'r1', 'user')).toBe('replay-$s-r1-u');
    expect(mirrorTxnId('$s', 'r1', 'oracle')).toBe('replay-$s-r1-o');
  });
});

describe('RoomMirror', () => {
  it('sends, logs the event id and keeps the work alive', async () => {
    const sendText = vi.fn().mockResolvedValue('$ev1');
    const { mirror, kept, log } = harness(sendText);
    await mirror.enqueue(
      '$s',
      async () => send('$s', 'hi', 't1'),
      'user message',
    );
    expect(sendText).toHaveBeenCalledOnce();
    expect(kept).toHaveLength(1);
    expect(log.mock.calls[0]?.[0]).toContain('$ev1');
    expect(mirror.pending).toBe(0);
  });

  it('retries a transient failure with the SAME transaction id and never rejects', async () => {
    const sendText = vi
      .fn()
      .mockRejectedValueOnce(transient())
      .mockRejectedValueOnce(transient())
      .mockResolvedValue('$ev');
    const { mirror, warn } = harness(sendText);
    await expect(
      mirror.enqueue(
        '$s',
        async () => send('$s', 'hi', 'fixed'),
        'user message',
      ),
    ).resolves.toBeUndefined();
    expect(sendText).toHaveBeenCalledTimes(3);
    expect(new Set(sendText.mock.calls.map((c) => c[0].txnId))).toEqual(
      new Set(['fixed']),
    );
    expect(warn).toHaveBeenCalledTimes(2); // one line per retry, none for the success
  });

  it('gives up on a non-transient failure after one attempt, logs, and moves on', async () => {
    const sendText = vi
      .fn()
      .mockRejectedValueOnce(new Error('M_FORBIDDEN: not in room'))
      .mockResolvedValue('$ev2');
    const { mirror, warn } = harness(sendText);
    await mirror.enqueue(
      '$s',
      async () => send('$s', 'a', 't1'),
      'user message',
    );
    await mirror.enqueue(
      '$s',
      async () => send('$s', 'b', 't2'),
      'AI response',
    );
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('M_FORBIDDEN');
  });

  it('keeps the order within a session while the first send is being retried', async () => {
    const order: string[] = [];
    let firstAttempts = 0;
    const sendText = vi.fn(async (s: MirrorSend) => {
      if (s.body === 'question' && firstAttempts++ === 0) throw transient();
      order.push(s.body);
      return `$${s.body}`;
    });
    const { mirror } = harness(sendText);
    const a = mirror.enqueue(
      '$s',
      async () => send('$s', 'question', 'u'),
      'user message',
    );
    const b = mirror.enqueue(
      '$s',
      async () => send('$s', 'answer', 'o'),
      'AI response',
    );
    await Promise.all([a, b]);
    expect(order).toEqual(['question', 'answer']);
  });

  it('runs different sessions in parallel', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const sendText = vi.fn(async (s: MirrorSend) => {
      if (s.threadId === '$slow') await gate;
      return `$${s.threadId}`;
    });
    const { mirror } = harness(sendText);
    const slow = mirror.enqueue(
      '$slow',
      async () => send('$slow', 'x', '1'),
      'user message',
    );
    const quick = mirror.enqueue(
      '$quick',
      async () => send('$quick', 'y', '2'),
      'user message',
    );
    await quick; // resolves without waiting for the slow session
    expect(mirror.pending).toBe(1);
    release();
    await slow;
    expect(mirror.pending).toBe(0);
  });

  it('skips a mirror whose preparation finds nothing to send, and one whose preparation fails', async () => {
    const sendText = vi.fn().mockResolvedValue('$ev');
    const { mirror, warn } = harness(sendText);
    await mirror.enqueue('$s', async () => null, 'user message');
    await mirror.enqueue(
      '$s',
      async () => {
        throw new Error('no oracle room for this user');
      },
      'AI response',
    );
    expect(sendText).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('no oracle room');
  });
});

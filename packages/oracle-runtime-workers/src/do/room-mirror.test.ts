import { describe, expect, it, vi } from 'vitest';
import {
  mediaEventContent,
  mirrorTxnId,
  mirrorEventContent,
  RoomMirror,
  type MediaMirrorSend,
  type MirrorSend,
} from './room-mirror';

const transient = () => new Error('Network connection lost');
const fast = { delaysMs: [1, 1, 1], sleep: async () => undefined };

function harness(
  sendText: (s: MirrorSend) => Promise<string>,
  sendEvent: (
    roomId: string,
    content: string,
    txnId: string,
  ) => Promise<string> = vi.fn(),
) {
  const kept: Promise<unknown>[] = [];
  const log = vi.fn();
  const warn = vi.fn();
  const mirror = new RoomMirror({
    sendText,
    sendEvent,
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

describe('channel provenance', () => {
  it('puts only the provider, binding and HMAC reference inside the message content', () => {
    const content = mirrorEventContent({
      ...send('$s', 'Hello', 'fixed'),
      origin: {
        provider: 'whatsapp',
        bindingId: 'chb_one',
        remoteMessageRef: `hmac:${'a'.repeat(64)}`,
      },
    });
    expect(content).toEqual({
      msgtype: 'm.text',
      body: 'Hello',
      'm.relates_to': {
        rel_type: 'm.thread',
        event_id: '$s',
        is_falling_back: true,
        'm.in_reply_to': { event_id: '$s' },
      },
      'org.ixo.qi.origin': {
        v: 1,
        transport: 'whatsapp',
        binding_id: 'chb_one',
        remote_ref: `hmac:${'a'.repeat(64)}`,
      },
    });
  });

  it('propagates required mirror failures so a channel reply cannot be marked delivered', async () => {
    const { mirror, kept } = harness(async () => {
      throw new Error('M_FORBIDDEN');
    });
    const pending = mirror.enqueue(
      '$s',
      async () => send('$s', 'answer', 'txn'),
      'AI response',
      true,
    );
    await expect(pending).rejects.toThrow('M_FORBIDDEN');
    await Promise.allSettled(kept);
  });

  it('a failed required mirror does not skip the next mirror queued in the same session', async () => {
    const sendText = vi
      .fn()
      .mockRejectedValueOnce(new Error('M_FORBIDDEN'))
      .mockResolvedValue('$ev');
    const { mirror, kept, warn } = harness(sendText);
    const failed = mirror.enqueue(
      '$s',
      async () => send('$s', 'channel answer', 'txn-channel'),
      'AI response',
      true,
    );
    const next = mirror.enqueue(
      '$s',
      async () => send('$s', 'portal message', 'txn-portal'),
      'user message',
    );
    await expect(failed).rejects.toThrow('M_FORBIDDEN');
    await next;
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sendText.mock.calls[1]?.[0]).toMatchObject({ txnId: 'txn-portal' });
    expect(warn).not.toHaveBeenCalled();
    await Promise.allSettled(kept);
  });
});

const ORIGIN = {
  provider: 'whatsapp',
  bindingId: 'chb_one',
  remoteMessageRef: `hmac:${'a'.repeat(64)}`,
};

const media = (threadId: string, txnId: string): MediaMirrorSend => ({
  roomId: '!room',
  threadId,
  txnId,
  origin: ORIGIN,
  media: {
    msgtype: 'm.image',
    body: 'photo.jpg',
    filename: 'photo.jpg',
    info: { mimetype: 'image/jpeg', size: 7 },
    file: {
      url: 'mxc://ixo.test/abc',
      v: 'v2',
      key: {
        kty: 'oct',
        key_ops: ['encrypt', 'decrypt'],
        alg: 'A256CTR',
        k: 'k',
        ext: true,
      },
      iv: 'iv',
      hashes: { sha256: 'h' },
    },
  },
});

describe('RoomMirror.sendMedia', () => {
  it('posts the file event in the thread with the origin of the text mirrors, and no quote', () => {
    expect(
      mediaEventContent({
        ...media('$s', 'm'),
        origin: { ...ORIGIN, replyTo: { kind: 'unavailable' } },
      }),
    ).toEqual({
      msgtype: 'm.image',
      body: 'photo.jpg',
      filename: 'photo.jpg',
      info: { mimetype: 'image/jpeg', size: 7 },
      file: {
        url: 'mxc://ixo.test/abc',
        v: 'v2',
        key: {
          kty: 'oct',
          key_ops: ['encrypt', 'decrypt'],
          alg: 'A256CTR',
          k: 'k',
          ext: true,
        },
        iv: 'iv',
        hashes: { sha256: 'h' },
      },
      'm.relates_to': {
        rel_type: 'm.thread',
        event_id: '$s',
        is_falling_back: true,
        'm.in_reply_to': { event_id: '$s' },
      },
      'org.ixo.qi.origin': {
        v: 1,
        transport: 'whatsapp',
        binding_id: 'chb_one',
        remote_ref: `hmac:${'a'.repeat(64)}`,
      },
    });
  });

  it("queues behind the session's text mirror, returns the event id and retries with the same transaction id", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const sendText = vi.fn(async (s: MirrorSend) => {
      await gate;
      order.push(s.body);
      return '$text';
    });
    let attempts = 0;
    const sendEvent = vi.fn(
      async (_room: string, content: string, _txnId: string) => {
        if (attempts++ === 0) throw transient();
        order.push(String(JSON.parse(content).body));
        return '$file';
      },
    );
    const { mirror } = harness(sendText, sendEvent);
    const text = mirror.enqueue(
      '$s',
      async () => send('$s', 'caption', 'u'),
      'user message',
    );
    const file = mirror.sendMedia(
      '$s',
      async () => media('$s', 'media-1'),
      'channel file',
    );
    release();
    await text;
    await expect(file).resolves.toBe('$file');
    expect(order).toEqual(['caption', 'photo.jpg']);
    expect(sendEvent.mock.calls.map((c) => c[2])).toEqual([
      'media-1',
      'media-1',
    ]);
    expect(mirror.pending).toBe(0);
  });

  it("rejects on a failed send and lets the session's next mirror go", async () => {
    const sendText = vi.fn().mockResolvedValue('$reply');
    const sendEvent = vi.fn().mockRejectedValue(new Error('M_FORBIDDEN'));
    const { mirror } = harness(sendText, sendEvent);
    const file = mirror.sendMedia(
      '$s',
      async () => media('$s', 'media-1'),
      'channel file',
    );
    const reply = mirror.enqueue(
      '$s',
      async () => send('$s', 'answer', 'o'),
      'AI response',
    );
    await expect(file).rejects.toThrow('M_FORBIDDEN');
    await reply;
    expect(sendText).toHaveBeenCalledOnce();
  });

  it('sends nothing for a caller that stopped waiting before its turn came', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const sendText = vi.fn(async () => {
      await gate;
      return '$text';
    });
    const sendEvent = vi.fn().mockResolvedValue('$file');
    const { mirror } = harness(sendText, sendEvent);
    void mirror.enqueue(
      '$s',
      async () => send('$s', 'caption', 'u'),
      'user message',
    );
    const controller = new AbortController();
    const prepare = vi.fn(async () => media('$s', 'media-1'));
    const file = mirror.sendMedia(
      '$s',
      prepare,
      'channel file',
      controller.signal,
    );
    controller.abort(new Error('deadline'));
    release();
    await expect(file).rejects.toThrow('deadline');
    expect(prepare).not.toHaveBeenCalled();
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it('keeps the queue order, not the upload order, and posts nothing for a file whose upload failed', async () => {
    const posted: string[] = [];
    const sendEvent = vi.fn(async (_room: string, content: string) => {
      posted.push(String(JSON.parse(content).body));
      return `$${posted.length}`;
    });
    const { mirror } = harness(vi.fn(), sendEvent);
    let finishFirst!: () => void;
    const firstUpload = new Promise<void>((r) => {
      finishFirst = r;
    });
    const first = mirror.sendMedia(
      '$s',
      async () => {
        await firstUpload;
        const m = media('$s', 'media-0');
        return { ...m, media: { ...m.media, body: 'first' } };
      },
      'channel file',
    );
    const failed = mirror.sendMedia('$s', async () => null, 'channel file');
    const second = mirror.sendMedia(
      '$s',
      async () => {
        const m = media('$s', 'media-2');
        return { ...m, media: { ...m.media, body: 'second' } };
      },
      'channel file',
    );
    // The second upload is done long before the first.
    await new Promise((r) => setTimeout(r, 5));
    expect(posted).toEqual([]);
    finishFirst();
    await expect(first).resolves.toBe('$1');
    await expect(failed).resolves.toBeNull();
    await expect(second).resolves.toBe('$2');
    expect(posted).toEqual(['first', 'second']);
  });

  it('makes no further attempt once the signal aborts between retries', async () => {
    const controller = new AbortController();
    const sendEvent = vi.fn(async () => {
      controller.abort(new Error('background bound'));
      throw transient();
    });
    const { mirror } = harness(vi.fn(), sendEvent);
    await expect(
      mirror.sendMedia(
        '$s',
        async () => media('$s', 'media-1'),
        'channel file',
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(sendEvent).toHaveBeenCalledOnce();
  });
});

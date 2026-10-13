import { describe, expect, it, vi } from 'vitest';
import { parseSSEStream, type SSEEvent } from './sse-parser';

const encode = (text: string) => new TextEncoder().encode(text);

async function parse(chunks: Uint8Array[]): Promise<SSEEvent[]> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const events: SSEEvent[] = [];
  for await (const event of parseSSEStream(stream.getReader()))
    events.push(event);
  return events;
}

describe('parseSSEStream framing', () => {
  it('parses whole frames with their ids', async () => {
    const events = await parse([
      encode(
        'id: 1\nevent: run\ndata: {"runId":"r1","sessionId":"s","requestId":"q"}\n\nid: 2\nevent: message\ndata: {"content":"hi","timestamp":"t"}\n\n',
      ),
    ]);
    expect(events).toEqual([
      {
        event: 'run',
        id: 1,
        data: { runId: 'r1', sessionId: 's', requestId: 'q' },
      },
      { event: 'message', id: 2, data: { content: 'hi', timestamp: 't' } },
    ]);
  });

  it('keeps a frame intact when the network splits it at every byte, UTF-8 included', async () => {
    const bytes = encode(
      'event: message\r\ndata: {"content":"héllo 🔥","timestamp":"t"}\r\n\r\nid: 7\nevent: done\ndata: {}\n\n',
    );
    const events = await parse(Array.from(bytes, (b) => Uint8Array.of(b)));
    expect(events).toEqual([
      { event: 'message', data: { content: 'héllo 🔥', timestamp: 't' } },
      { event: 'done', id: 7, data: {} },
    ]);
  });

  it('does not let a heartbeat comment end a frame in progress, and delivers a last unterminated frame', async () => {
    const events = await parse([
      encode('event: done\n: heartbeat\ndata: {"runId":"r1"}'),
    ]);
    expect(events).toEqual([{ event: 'done', data: { runId: 'r1' } }]);
  });

  it('joins several data lines with newlines', async () => {
    const events = await parse([
      encode(
        'event: message\ndata: {"content":\ndata: "two",\ndata: "timestamp":"t"}\n\n',
      ),
    ]);
    expect(events).toEqual([
      { event: 'message', data: { content: 'two', timestamp: 't' } },
    ]);
  });

  it('skips a frame whose data is not JSON and an unknown event, and goes on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const events = await parse([
        encode(
          'event: action_call\ndata: {broken}\n\nevent: telemetry\ndata: {"x":1}\n\nevent: done\ndata: {}\n\n',
        ),
      ]);
      expect(events).toEqual([{ event: 'done', data: {} }]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps a \\r\\n line end intact when a read ends between the \\r and the \\n', async () => {
    const events = await parse([
      encode('event: message\r'),
      encode('\ndata: {"content":"a","timestamp":"t"}\r'),
      encode('\n\r'),
      encode('\nevent: done\r\ndata: {}\r\n\r\n'),
    ]);
    expect(events).toEqual([
      { event: 'message', data: { content: 'a', timestamp: 't' } },
      { event: 'done', data: {} },
    ]);
  });

  it('assembles a frame whose fields arrive in separate reads', async () => {
    const events = await parse([
      encode('id: 4\n'),
      encode('event: mess'),
      encode('age\ndata: {"content":'),
      encode('"split","timestamp":"t"}\n'),
      encode('\n'),
    ]);
    expect(events).toEqual([
      {
        event: 'message',
        id: 4,
        data: { content: 'split', timestamp: 't' },
      },
    ]);
  });

  it('decodes multi-byte characters cut at chunk boundaries inside a data line', async () => {
    const bytes = encode(
      'event: message\ndata: {"content":"日本🔥é","timestamp":"t"}\n\n',
    );
    const at = (s: string) => bytes.indexOf(encode(s)[0]!);
    // Cut inside the 3-byte "日", the 4-byte "🔥" and the 2-byte "é".
    const cuts = [at('日') + 1, at('🔥') + 2, at('é') + 1];
    const chunks: Uint8Array[] = [];
    let from = 0;
    for (const cut of cuts) {
      chunks.push(bytes.slice(from, cut));
      from = cut;
    }
    chunks.push(bytes.slice(from));
    expect(await parse(chunks)).toEqual([
      { event: 'message', data: { content: '日本🔥é', timestamp: 't' } },
    ]);
  });

  it('skips a last frame cut off inside its data line, without failing the stream', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const events = await parse([
        encode(
          'event: message\ndata: {"content":"kept","timestamp":"t"}\n\nid: 9\nevent: message\ndata: {"content":"cu',
        ),
      ]);
      expect(events).toEqual([
        { event: 'message', data: { content: 'kept', timestamp: 't' } },
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('delivers nothing for a last frame that has an event name but no data yet', async () => {
    expect(
      await parse([encode('event: done\n: heartbeat\nevent: mess')]),
    ).toEqual([]);
  });

  it('parses a very long data line delivered over many reads', async () => {
    const content = 'x'.repeat(2 * 1024 * 1024);
    const bytes = encode(
      `id: 1\nevent: message\ndata: {"content":"${content}","timestamp":"t"}\n\n`,
    );
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 16 * 1024)
      chunks.push(bytes.slice(i, i + 16 * 1024));
    const events = await parse(chunks);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'message', id: 1 });
    expect(
      events[0]!.event === 'message' && events[0]!.data.content.length,
    ).toBe(content.length);
  });

  it('ends quietly when the read is aborted', async () => {
    const abortError = Object.assign(new Error('aborted'), {
      name: 'AbortError',
    });
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(abortError);
      },
    });
    const events: SSEEvent[] = [];
    for await (const event of parseSSEStream(stream.getReader()))
      events.push(event);
    expect(events).toEqual([]);
  });

  it('rethrows any other read failure', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('connection reset'));
      },
    });
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    try {
      await expect(parse([]).then(() => undefined)).resolves.toBeUndefined();
      const reader = stream.getReader();
      await expect(
        (async () => {
          for await (const _ of parseSSEStream(reader)) void _;
        })(),
      ).rejects.toThrow('connection reset');
    } finally {
      error.mockRestore();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { parseSSEStream } from './sse-parser';

async function parse(chunks: Uint8Array[]) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const events = [];
  for await (const event of parseSSEStream(stream.getReader()))
    events.push(event);
  return events;
}
const encode = (text: string) => new TextEncoder().encode(text);
describe('SSE framing', () => {
  it('preserves an event split across every byte, including UTF-8', async () => {
    const data = encode(
      'event: message\r\ndata: {"content":"héllo"}\r\n\r\nevent: done\ndata: {}\n\n',
    );
    const events = await parse(Array.from(data, (byte) => Uint8Array.of(byte)));
    expect(events).toEqual([
      { event: 'message', data: { content: 'héllo' } },
      { event: 'done', data: {} },
    ]);
  });
  it('keeps heartbeat comments separate from event delimiters and accepts the last unterminated frame', async () => {
    const events = await parse([encode('event: done\n: heartbeat\ndata: {}')]);
    expect(events).toEqual([{ event: 'done', data: {} }]);
  });
  it('surfaces malformed frames instead of silently losing an action', async () => {
    await expect(
      parse([encode('event: action_call\ndata: {broken}\n\n')]),
    ).rejects.toThrow();
  });
});

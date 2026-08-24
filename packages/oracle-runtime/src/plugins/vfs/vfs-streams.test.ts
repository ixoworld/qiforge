import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { nodeToWebStream, webToNodeStream } from './vfs-streams.js';

async function collect(readable: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe('vfs stream helpers', () => {
  it('round-trips bytes node → web → node', async () => {
    const payload = Buffer.from('a'.repeat(100_000));
    const web = nodeToWebStream(
      Readable.from([payload.subarray(0, 60_000), payload.subarray(60_000)]),
    );
    const back = await collect(webToNodeStream(web));
    expect(back.equals(payload)).toBe(true);
  });

  it('cancels the web body when the node readable is destroyed', async () => {
    // A failed pipeline (disk full) destroys the node side; without the
    // cancel the worker keeps streaming the whole file to nobody.
    let cancelled = false;
    const web = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('first-chunk'));
      },
      cancel() {
        cancelled = true;
      },
    });

    const node = webToNodeStream(web);
    // Pull one chunk so the generator is parked at its `yield`, then destroy.
    for await (const _chunk of node) break;
    await new Promise((resolve) => setImmediate(resolve));

    expect(node.destroyed).toBe(true);
    expect(cancelled).toBe(true);
  });

  it('destroys the node source when the web stream is cancelled', async () => {
    const source = Readable.from([Buffer.from('x')]);
    const web = nodeToWebStream(source);
    await web.cancel();
    expect(source.destroyed).toBe(true);
  });
});

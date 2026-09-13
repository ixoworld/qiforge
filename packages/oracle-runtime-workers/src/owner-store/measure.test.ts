import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { measureForSave } from './measure';
import { countStream, gzipStream, streamOfBytes } from './types';

function bytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    // Mostly compressible with some noise, like a SQLite file.
    out[i] = i % 7 === 0 ? x & 0xff : (i >> 4) & 0xff;
  }
  return out;
}

describe('measureForSave', () => {
  it('yields the SHA-256 of the raw bytes and the exact gzipped length in one pass', async () => {
    for (const size of [0, 1, 4096, 300_000, 2_500_000]) {
      const data = bytes(size, size + 3);
      const measured = await measureForSave(streamOfBytes(data));
      expect(measured.sha256Hex).toBe(
        createHash('sha256').update(data).digest('hex'),
      );
      expect(measured.gzippedLength).toBe(
        await countStream(gzipStream(streamOfBytes(data))),
      );
    }
  });

  it('consumes the stream exactly once', async () => {
    let pulls = 0;
    const data = bytes(200_000, 9);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        const start = (pulls - 1) * 65_536;
        if (start >= data.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(data.subarray(start, start + 65_536));
      },
    });
    const measured = await measureForSave(stream);
    expect(pulls).toBe(Math.ceil(data.byteLength / 65_536) + 1);
    expect(measured.sha256Hex).toBe(
      createHash('sha256').update(data).digest('hex'),
    );
  });
});

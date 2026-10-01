/**
 * One streamed pass over a snapshot that yields BOTH what a flush needs
 * before it uploads: the SHA-256 of the raw SQLite bytes (the "did anything
 * change" gate against the last upload) and the exact gzipped length (the
 * VFS needs `Upload-Length` when the tus session is created). Before this
 * helper the object hashed in one pass and the store counted the gzip in a
 * second one; with the R2 page tier every pass over a cold file is one R2
 * GET per segment, so the two are folded together and the upload itself is
 * the only other read.
 *
 * The length is exact for the store's own gzip: `gzipStream` is the same
 * `CompressionStream('gzip')` the stores pipe the upload through, and its
 * output is deterministic for identical input.
 */
import { createHash } from 'node:crypto';
import { countStream, gzipStream } from './types';

export interface SnapshotMeasure {
  /** Hex SHA-256 of the raw (uncompressed) bytes. */
  sha256Hex: string;
  /** Byte length of `gzipStream(<the same bytes>)`. */
  gzippedLength: number;
}

export async function measureForSave(
  stream: ReadableStream<Uint8Array>,
): Promise<SnapshotMeasure> {
  const hash = createHash('sha256');
  const tapped = stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        hash.update(chunk);
        controller.enqueue(chunk);
      },
    }),
  );
  const gzippedLength = await countStream(gzipStream(tapped));
  return { sha256Hex: hash.digest('hex'), gzippedLength };
}

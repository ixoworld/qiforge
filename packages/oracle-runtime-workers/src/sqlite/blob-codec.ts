/**
 * Lossless per-blob gzip for the checkpointer's BLOB columns.
 *
 * The saver's schema already stores each message once (`messages` PK is the
 * message id) and prunes checkpoints per thread, so the remaining size lever
 * is the serialized JSON itself. Every blob written through this codec is
 * gzip-compressed; reads detect the gzip magic bytes and decompress
 * transparently, so legacy uncompressed rows (files written by the Node
 * runtime, or by this runtime before the codec) keep loading unchanged and
 * both kinds coexist in one file.
 *
 * NOT compressed: `checkpoints.metadata` — `list()` filters it SQL-side via
 * `json(CAST(metadata AS TEXT))`, which must keep seeing plaintext JSON. It
 * is bounded (source/step/parents) so the loss is negligible.
 *
 * A compressed blob is a plain gzip stream — `gunzip` on the exported file
 * shows the original JSON. Nothing is dropped, reordered, or summarized:
 * compress(decompress(x)) round-trips bit-exact at the value level.
 */

import { gunzipSync, gzipSync } from 'node:zlib';

/** Blobs below this size gain nothing from gzip (header ≈ 20 bytes). */
export const MIN_COMPRESS_BYTES = 256;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * One gzip/gunzip of a whole value, through node:zlib's one-shot calls, so
 * the zlib state lives for the call only. A `CompressionStream` /
 * `DecompressionStream` keeps its zlib state (zlib's defaults: about
 * 256 KiB to deflate, about 40 KiB to inflate) outside the JS heap until
 * the stream is collected, and the saver gzips or gunzips every message
 * row of a thread on each checkpoint read and write. On a deployed oracle a
 * turn on a 200-message, 410 KB thread left 6 MiB of the Durable Object's
 * 128 MB with streams and 50 MiB with one-shot calls (an empty thread: 58).
 * Same gzip format either way, so existing rows read back unchanged.
 */
export function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  // A copy: an exact-size `Uint8Array`, not a `Buffer` view.
  return Promise.resolve(new Uint8Array(gzipSync(bytes)));
}

export function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  return Promise.resolve(new Uint8Array(gunzipSync(bytes)));
}

/**
 * Encode one value for a BLOB column: small values pass through untouched;
 * larger ones are gzipped. An incompressible payload (already-compressed
 * media) that would GROW is stored uncompressed.
 */
export async function compressForStorage(
  data: Uint8Array | string,
): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? textEncoder.encode(data) : data;
  if (bytes.length < MIN_COMPRESS_BYTES) return bytes;
  const compressed = await gzipBytes(bytes);
  return compressed.length < bytes.length ? compressed : bytes;
}

/**
 * Read one BLOB/TEXT column value back to its JSON text, decompressing when
 * the gzip magic is present. Handles every historical shape: TEXT rows,
 * legacy plain BLOBs, and codec-written gzip BLOBs.
 */
export async function readBlobText(raw: Uint8Array | string): Promise<string> {
  if (typeof raw === 'string') return raw;
  const bytes = isGzip(raw) ? await gunzipBytes(raw) : raw;
  return textDecoder.decode(bytes);
}

/** Decode SQLite `hex(column)` output (upper-case hex) back to bytes. */
export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * The user-owned durable copy of their SQLite file.
 *
 * The Durable Object only ever holds a *working copy* (pages in its storage).
 * The file the user owns — the one they can download, delete, or move to
 * another provider — lives behind this interface. Implementations:
 *
 *   - `MatrixMediaOwnerStore` — gzipped file as room media in the user's
 *     Matrix room, addressed by `m.ixo.media_state[storageKey]`. Wire-identical
 *     to the Node runtime, so existing users migrate with no action.
 *   - `IxoVfsOwnerStore` — `/.oracles/<oracleDid>/state.db.gz` in the user's
 *     IXO VFS, written with an `fs/write` invocation minted from the user's
 *     delegation.
 *
 * Both directions STREAM: `load()` hands back the raw (already gunzipped)
 * SQLite bytes as a `ReadableStream` the object writes into its VFS chunk by
 * chunk, and `save()` takes a `FileSnapshot` — a re-openable, consistent
 * view of the working copy — that the store reads as many times as it needs.
 * The object measures the hash and the gzipped length in ONE pass
 * (`measureForSave`) and hands the length in as a `SaveHints`, so a store
 * only reads the snapshot once more, for the upload itself; a store called
 * without the hint counts the gzip in a pass of its own. That matters with
 * the R2 page tier, where every pass over a cold file is one R2 GET per
 * segment. Nothing on this path ever holds the whole file in memory — the
 * legacy Matrix media path included: the gateway hands the media over as a
 * stream and decryption, gunzip and the SQLite header check run chunk by
 * chunk in the object. Compression is the store's concern. `etag` lets the object skip a reload
 * when nothing changed upstream.
 */
export interface OwnerStore {
  readonly kind: 'matrix' | 'vfs';
  load(): Promise<OwnerCopy | null>;
  save(snapshot: FileSnapshot, hints?: SaveHints): Promise<SaveResult>;
  /** Cheap upstream freshness probe — null when unsupported/unknown. */
  head(): Promise<{ etag: string } | null>;
  /** Remove the durable copy (user asked to be forgotten). */
  /** Delete the copy; `reason` lands in the audit trail where the backend keeps one (Matrix redaction). */
  remove(reason?: string): Promise<void>;
  /**
   * The read-only legacy copy (the Node runtime's Matrix room media), when
   * this store fronts one. Lets the object adopt a user's pre-migration
   * history even after a never-chatted working copy has already written an
   * empty file to the system of record. Absent on stores without a legacy
   * source.
   */
  loadLegacy?(): Promise<OwnerCopy | null>;
  /**
   * Remove the legacy copy once the primary is confirmed to hold the file
   * with `expectedEtag`. Resolves true when a legacy copy was removed.
   */
  removeLegacyCopy?(expectedEtag: string): Promise<boolean>;
}

/** A durable copy being read: raw SQLite bytes, streamed. */
export interface OwnerCopy {
  stream: ReadableStream<Uint8Array>;
  etag: string;
  /**
   * The bytes come from the read-only legacy source (the Node runtime's
   * Matrix room media) and are not in the system of record yet: the object
   * imports them chunk by chunk, then writes them to the primary store from
   * its working copy — the one-time migration, streamed both ways.
   */
  fromLegacy?: true;
}

/** What the caller already measured about the snapshot (see `measureForSave`). */
export interface SaveHints {
  /** Byte length of `gzipStream(snapshot.open())`; spares the store its counting pass. */
  gzippedLength?: number;
}

export interface SaveResult {
  etag: string;
  /** Bytes actually sent upstream (compressed size on the VFS path). */
  bytes: number;
}

/**
 * A consistent view of the working copy that can be read more than once.
 * `size` is the raw SQLite length; every `open()` streams the same bytes.
 */
export interface FileSnapshot {
  readonly size: number;
  open(): ReadableStream<Uint8Array>;
}

export function snapshotOfBytes(bytes: Uint8Array): FileSnapshot {
  return { size: bytes.byteLength, open: () => streamOfBytes(bytes) };
}

export function streamOfBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Blob([toArrayBuffer(bytes)]).stream();
}

export async function bytesOfStream(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Bytes flowing through `stream`, discarded (a counting pass). */
export async function countStream(
  stream: ReadableStream<Uint8Array>,
): Promise<number> {
  const reader = stream.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return total;
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

export function gzipStream(
  stream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  return stream.pipeThrough(new CompressionStream('gzip'));
}

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

/**
 * Gunzip `stream` when it carries the gzip magic, else pass it through
 * untouched (an uncompressed legacy upload). Peeks at the first bytes and
 * re-prepends them, so nothing is buffered beyond the first chunk.
 */
export async function gunzipStreamIfNeeded(
  stream: ReadableStream<Uint8Array>,
): Promise<ReadableStream<Uint8Array>> {
  const { head, rest } = await peekStream(stream, 2);
  const gzipped =
    head.byteLength >= 2 &&
    head[0] === GZIP_MAGIC_0 &&
    head[1] === GZIP_MAGIC_1;
  return gzipped ? rest.pipeThrough(new DecompressionStream('gzip')) : rest;
}

/**
 * Read the first `n` bytes of `stream` without consuming it: `head` holds
 * what was read (fewer bytes when the stream ended early) and `rest` is the
 * whole stream again, those bytes re-prepended. Nothing beyond the chunks
 * that carried the first `n` bytes is buffered.
 */
export async function peekStream(
  stream: ReadableStream<Uint8Array>,
  n: number,
): Promise<{ head: Uint8Array; rest: ReadableStream<Uint8Array> }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;
  let ended = false;
  while (seen < n) {
    const { done, value } = await reader.read();
    if (done) {
      ended = true;
      break;
    }
    chunks.push(value);
    seen += value.byteLength;
  }
  const flat = concat(chunks);
  const rest = new ReadableStream<Uint8Array>({
    start(controller) {
      if (flat.byteLength > 0) controller.enqueue(flat);
      if (ended) controller.close();
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return { head: flat.subarray(0, n), rest };
}

const SQLITE_HEADER_BYTES = 16;

/**
 * Fail fast on a stream that is not a SQLite file: peeks at the header and
 * hands the stream back untouched when it is one, otherwise cancels it and
 * throws `<what> is not a SQLite file`. The chunk VFS checks the header
 * again as it writes; this is what lets a store reject a corrupt or foreign
 * upload before anything downstream starts.
 */
export async function assertSqliteStream(
  stream: ReadableStream<Uint8Array>,
  what: string,
): Promise<ReadableStream<Uint8Array>> {
  const { head, rest } = await peekStream(stream, SQLITE_HEADER_BYTES);
  if (isSqliteFile(head)) return rest;
  await rest.cancel(`${what} is not a SQLite file`).catch(() => undefined);
  throw new Error(
    `${what} is not a SQLite file (${head.byteLength} header byte(s) read)`,
  );
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 0) return new Uint8Array(0);
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Copy a view into a standalone ArrayBuffer (Blob wants an exact buffer, not a view). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([toArrayBuffer(bytes)])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([toArrayBuffer(bytes)])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** `SQLite format 3\0` — first 16 bytes of every SQLite file. */
export function isSqliteFile(bytes: Uint8Array): boolean {
  const magic = 'SQLite format 3 ';
  if (bytes.length < 16) return false;
  for (let i = 0; i < 16; i++)
    if (bytes[i] !== magic.charCodeAt(i)) return false;
  return true;
}

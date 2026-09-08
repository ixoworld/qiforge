/**
 * Minimal tus 1.0.0 client (creation + resume) for the IXO VFS
 * (`/api/fs/upload`, see the VFS repo's RESUMABLE_UPLOADS.md).
 *
 * Reads `source()` part by part — never more than one `partSize` buffer in
 * memory — and PATCHes each part at its offset. A failed part is retried
 * with backoff after probing `HEAD` for the committed offset, so a part the
 * server did take (response lost) is not sent twice and a part it did not
 * take is resent from the same buffer. The VFS does not support
 * `Upload-Defer-Length`, so the caller must know `totalLength` up front (the
 * owner store measures it with a counting pass over the same source).
 *
 * Part rules enforced by the server: every non-final part must be a
 * multiple of 64 KiB and at least 5 MiB; a single part covering the whole
 * upload has no alignment demands. Every request carries fresh auth
 * headers from `authHeaders()` (single-use UCAN invocations).
 */
import { DEFAULT_RETRY_DELAYS_MS, isNetworkError } from './retry';

export const TUS_VERSION = '1.0.0';
export const TUS_PART_ALIGN_BYTES = 64 * 1024;
export const TUS_MIN_PART_BYTES = 5 * 1024 * 1024;

/** Statuses after which resending the same part can never succeed. */
const FATAL_STATUSES = new Set([400, 401, 403, 404, 410, 411, 412, 413, 415]);

export class TusUploadError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'TusUploadError';
  }
}

export interface TusUploadOptions {
  /** Creation endpoint, e.g. `https://vfs/api/fs/upload`. */
  endpoint: string;
  path: string;
  contentType: string;
  totalLength: number;
  partSize: number;
  /** Re-openable byte source; read exactly once per upload attempt. */
  source: () => ReadableStream<Uint8Array>;
  /** Fresh auth headers for every request. */
  authHeaders: () => Promise<Record<string, string>>;
  fetchImpl: typeof fetch;
  /** Per-request timeout (headers + body for parts). */
  timeoutMs?: number;
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface TusUploadResult {
  /** Null when the final PATCH was committed but its response was lost. */
  fileId: string | null;
  contentHash: string | null;
  cid: string | null;
  parts: number;
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function uploadMetadata(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key} ${base64(value)}`)
    .join(',');
}

/** Reads fixed-size parts from a stream; the last one may be shorter. */
class PartReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private carry: Uint8Array | null = null;
  private ended = false;

  constructor(
    stream: ReadableStream<Uint8Array>,
    private readonly partSize: number,
  ) {
    this.reader = stream.getReader();
  }

  /** Next part, or null at end of stream. */
  async next(): Promise<Uint8Array | null> {
    if (this.ended && this.carry === null) return null;
    const out = new Uint8Array(this.partSize);
    let fill = 0;
    while (fill < this.partSize) {
      let chunk: Uint8Array;
      if (this.carry !== null) {
        chunk = this.carry;
        this.carry = null;
      } else if (this.ended) {
        break;
      } else {
        const { done, value } = await this.reader.read();
        if (done) {
          this.ended = true;
          break;
        }
        chunk = value;
      }
      const n = Math.min(chunk.byteLength, this.partSize - fill);
      out.set(chunk.subarray(0, n), fill);
      fill += n;
      if (n < chunk.byteLength) this.carry = chunk.subarray(n);
    }
    if (fill === 0) return null;
    return fill === this.partSize ? out : out.subarray(0, fill);
  }

  release(): void {
    this.reader.releaseLock();
  }
}

export async function tusUpload(
  options: TusUploadOptions,
): Promise<TusUploadResult> {
  const {
    totalLength,
    partSize,
    fetchImpl,
    authHeaders,
    timeoutMs = 120_000,
  } = options;
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? (() => undefined);
  if (totalLength < 1)
    throw new TusUploadError('tus: totalLength must be ≥ 1', undefined, false);
  if (
    totalLength > partSize &&
    (partSize < TUS_MIN_PART_BYTES || partSize % TUS_PART_ALIGN_BYTES !== 0)
  ) {
    throw new TusUploadError(
      `tus: partSize ${partSize} must be a multiple of ${TUS_PART_ALIGN_BYTES} and ≥ ${TUS_MIN_PART_BYTES}`,
      undefined,
      false,
    );
  }

  const request = async (
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: Uint8Array,
  ): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, {
        method,
        headers: {
          ...(await authHeaders()),
          'Tus-Resumable': TUS_VERSION,
          ...headers,
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  const failure = async (
    what: string,
    res: Response,
  ): Promise<TusUploadError> => {
    const text = await res.text().catch(() => '');
    return new TusUploadError(
      `tus: ${what} → ${res.status} ${text.slice(0, 200)}`,
      res.status,
      !FATAL_STATUSES.has(res.status),
    );
  };

  // ── creation ──────────────────────────────────────────────────────────
  let sessionUrl: string | null = null;
  for (let attempt = 0; sessionUrl === null; attempt++) {
    try {
      const res = await request('POST', options.endpoint, {
        'Upload-Length': String(totalLength),
        'Upload-Metadata': uploadMetadata({
          path: options.path,
          contentType: options.contentType,
        }),
      });
      if (res.status !== 201) throw await failure('create', res);
      const location = res.headers.get('location');
      if (!location)
        throw new TusUploadError(
          'tus: create answered without Location',
          201,
          false,
        );
      sessionUrl = new URL(location, options.endpoint).toString();
    } catch (error) {
      const delay = delays[attempt];
      if (delay === undefined || !isRetryable(error)) throw error;
      log(`tus: create failed (${describe(error)}) — retry in ${delay} ms`);
      await sleep(delay);
    }
  }

  // ── parts ─────────────────────────────────────────────────────────────
  const parts = new PartReader(options.source(), partSize);
  let offset = 0;
  let count = 0;
  const result: TusUploadResult = {
    fileId: null,
    contentHash: null,
    cid: null,
    parts: 0,
  };
  const abortSession = async (): Promise<void> => {
    try {
      await request('DELETE', sessionUrl, {});
    } catch {
      // Best effort: R2's incomplete-multipart rule cleans up eventually.
    }
  };
  try {
    for (;;) {
      const part = await parts.next();
      if (part === null) break;
      if (offset + part.byteLength > totalLength) {
        throw new TusUploadError(
          `tus: source produced more than the declared ${totalLength} bytes`,
          undefined,
          false,
        );
      }
      count += 1;
      const final = offset + part.byteLength === totalLength;
      let sent = false;
      for (let attempt = 0; !sent; attempt++) {
        try {
          const res = await request(
            'PATCH',
            sessionUrl,
            {
              'Upload-Offset': String(offset),
              'Content-Type': 'application/offset+octet-stream',
            },
            part,
          );
          if (!res.ok) throw await failure(`part ${count} @${offset}`, res);
          if (final) {
            result.fileId = res.headers.get('x-vfs-file-id');
            result.contentHash = res.headers.get('x-vfs-content-hash');
            result.cid = res.headers.get('x-vfs-cid');
          }
          sent = true;
        } catch (error) {
          const delay = delays[attempt];
          if (delay === undefined || !isRetryable(error)) throw error;
          log(
            `tus: part ${count} @${offset} failed (${describe(error)}) — probing offset, retry in ${delay} ms`,
          );
          await sleep(delay);
          const committed = await committedOffset(request, sessionUrl);
          if (committed === offset + part.byteLength) {
            // The server took it; only the response was lost. For the final
            // part the session is gone with it — the caller resolves the
            // file by path.
            sent = true;
          } else if (committed !== null && committed !== offset) {
            throw new TusUploadError(
              `tus: committed offset ${committed} does not match our ${offset}; the session cannot be resumed`,
              undefined,
              false,
            );
          }
        }
      }
      offset += part.byteLength;
    }
    if (offset !== totalLength) {
      throw new TusUploadError(
        `tus: source produced ${offset} bytes but ${totalLength} were declared`,
        undefined,
        false,
      );
    }
  } catch (error) {
    await abortSession();
    throw error;
  } finally {
    parts.release();
  }
  result.parts = count;
  return result;
}

/** `HEAD` the session; null when the probe itself failed or the session is gone. */
async function committedOffset(
  request: (
    method: string,
    url: string,
    headers: Record<string, string>,
  ) => Promise<Response>,
  sessionUrl: string,
): Promise<number | null> {
  try {
    const res = await request('HEAD', sessionUrl, {});
    if (!res.ok) return null;
    const value = res.headers.get('upload-offset');
    return value === null ? null : Number(value);
  } catch {
    return null;
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof TusUploadError) return error.retryable;
  return isNetworkError(error);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

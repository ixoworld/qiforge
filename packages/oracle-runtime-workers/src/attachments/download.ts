/**
 * Fetching attachment bytes — Matrix media (through the gateway, which holds
 * the authenticated client and the room keys) and plain `http(s)` URLs with
 * the Node runtime's SSRF guard, manual redirect validation and streaming
 * size cap.
 */
import { containerMatchesClaim, detectMimeFromMagicBytes } from './magic';
import type { AttachmentInput } from './types';

export const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB per file
export const MAX_TOTAL_SIZE = 50 * 1024 * 1024; // 50 MB across all attachments
export const ALLOWED_URI_SCHEMES = /^(mxc|https?):\/\//i;
const MAX_REDIRECT_COUNT = 5;
/** Upper bound on one attachment download, from the request to the last byte. */
export const DOWNLOAD_TIMEOUT_MS = 60_000;

/** Blocks redirects to internal / cloud-metadata addresses (SSRF). */
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/, // AWS/cloud metadata
  /^0\.0\.0\.0$/,
  /^\[::1?\]$/, // IPv6 loopback (bracketed)
  /^\[::ffff:[^\]]+\]$/i, // IPv4-mapped IPv6
  /^\[f[cd][0-9a-f]{2}:.*\]$/i, // IPv6 unique-local (fc00::/7)
  /^\[fe[89ab][0-9a-f]:.*\]$/i, // IPv6 link-local (fe80::/10)
  /^metadata\.google\.internal$/i,
];

/**
 * The file itself is refused — empty, or larger than the cap it was fetched
 * under. Another download of the same file cannot succeed, so the pipeline
 * notes it instead of retrying.
 */
export class AttachmentRejectedError extends Error {
  override readonly name: string = 'AttachmentRejectedError';
}

/** The file is larger than the cap the download ran under. */
export class AttachmentTooLargeError extends AttachmentRejectedError {
  override readonly name: string = 'AttachmentTooLargeError';
}

function tooLarge(maxBytes: number): AttachmentTooLargeError {
  return new AttachmentTooLargeError(
    `File exceeds maximum size (${Math.round(maxBytes / 1024 / 1024)} MB) — download aborted`,
  );
}

/** The signal's reason as an Error (an aborter may pass any value). */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error(
    reason === undefined ? 'Attachment download aborted' : String(reason),
  );
}

/**
 * `work`, or the signal's reason as soon as it aborts — so a transfer that
 * ignores the signal still cannot hold the caller past it.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Throws when the URL is not http(s) or points at a blocked internal host. */
export function validateUrlTarget(targetUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Blocked URL scheme: ${parsed.protocol}`);
  }
  for (const pattern of BLOCKED_HOST_PATTERNS) {
    if (pattern.test(parsed.hostname)) {
      throw new Error('URL points to a blocked internal address');
    }
  }
}

/**
 * Matrix media access the pipeline needs. Implemented over the gateway
 * Durable Object in the user object; tests pass an in-memory fake.
 *
 * `signal` aborts at the download deadline or when the turn is aborted: an
 * implementation stops the transfer then (`readBytesCapped` with the signal
 * cancels the stream). The pipeline stops waiting at that moment either way.
 */
export interface MatrixMediaSource {
  /**
   * Raw bytes behind an `mxc://` URI (authenticated media download), the
   * transfer cut off once it passes `maxBytes`.
   */
  downloadMxc(
    mxc: string,
    maxBytes?: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  /**
   * Bytes of the media event `eventId` in `roomId`, decrypted when the event
   * carries an encrypted `file`, the transfer cut off once it passes
   * `maxBytes`. Null when the event does not exist.
   */
  downloadEvent(
    roomId: string,
    eventId: string,
    maxBytes?: number,
    signal?: AbortSignal,
  ): Promise<{
    bytes: Uint8Array;
    mimetype?: string;
    filename?: string;
  } | null>;
}

export interface DownloadOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * A controller that aborts on `signal` (with its reason) OR after
 * `timeoutMs` (with a timeout error), whichever comes first.
 */
function boundedSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  const onAbort = (): void => {
    if (signal) controller.abort(signal.reason);
  };
  if (signal?.aborted) controller.abort(signal.reason);
  signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(
          `Attachment download timed out after ${Math.round(timeoutMs / 1000)} s`,
        ),
      ),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    release: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Collect a stream into bytes with a running size check: the moment the
 * total passes `maxBytes` the stream is cancelled and an
 * `AttachmentTooLargeError` thrown, so an oversized file never lands in
 * memory whole. When `signal` aborts, the stream is cancelled and the
 * signal's reason thrown — a stalled source cannot hold the reader.
 */
export async function readBytesCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const cancel = (reason?: unknown): void => {
    reader.cancel(reason).catch(() => undefined);
  };
  if (signal?.aborted) {
    cancel(signal.reason);
    throw abortError(signal);
  }
  const onAbort = (): void => cancel(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      // A cancel settles the pending read as `done`: not a complete file.
      if (signal?.aborted) throw abortError(signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        cancel();
        throw tooLarge(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  return concat(chunks, total);
}

/**
 * Download an http(s) URL: every redirect hop is SSRF-validated, the body is
 * streamed with a running size check so an oversized file never lands in
 * memory whole.
 */
export async function downloadFromUrl(
  url: string,
  opts: DownloadOptions = {},
): Promise<{ data: Uint8Array; contentType?: string; finalUrl?: string }> {
  validateUrlTarget(url);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? MAX_FILE_SIZE;
  const bound = boundedSignal(
    opts.signal,
    opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
  );
  try {
    let currentUrl = url;
    let response: Response | undefined;
    for (let i = 0; i <= MAX_REDIRECT_COUNT; i += 1) {
      response = await fetchImpl(currentUrl, {
        signal: bound.signal,
        redirect: 'manual',
      });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        currentUrl = new URL(location, currentUrl).toString();
        validateUrlTarget(currentUrl);
        continue;
      }
      break;
    }
    if (!response) throw new Error('Too many redirects');
    if (response.status >= 300 && response.status < 400) {
      throw new Error(
        response.headers.get('location')
          ? 'Too many redirects'
          : `HTTP ${response.status} redirect without a Location header from ${currentUrl}`,
      );
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} downloading ${url}`);
    }
    const contentType =
      response.headers.get('content-type')?.split(';')[0]?.trim() ?? undefined;
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > maxBytes) {
      throw new AttachmentTooLargeError(
        `File too large: server reports ${Math.round(parseInt(contentLength, 10) / 1024 / 1024)} MB (limit: ${Math.round(maxBytes / 1024 / 1024)} MB)`,
      );
    }
    if (!response.body) throw new Error('Response body is not readable');
    return {
      data: await readBytesCapped(response.body, maxBytes, bound.signal),
      contentType,
      ...(currentUrl !== url ? { finalUrl: currentUrl } : {}),
    };
  } finally {
    bound.release();
  }
}

/**
 * Bytes for one attachment from whichever source it names, with the per-file
 * cap (`opts.maxBytes`, default `MAX_FILE_SIZE`) enforced before and during
 * the transfer and the `DOWNLOAD_TIMEOUT_MS` deadline (or `opts.timeoutMs`)
 * on every source — Matrix media included. `mimetype` is the best-known
 * type: content sniffing (`sniffed` is then true; a container signature
 * consistent with the claim, such as a zip for a `.docx`, keeps the claimed
 * type), then the HTTP `content-type`, then the client's claim. An empty
 * file is refused.
 */
export async function loadAttachmentBytes(
  attachment: AttachmentInput,
  roomId: string | undefined,
  source: MatrixMediaSource,
  opts: DownloadOptions = {},
): Promise<{ bytes: Uint8Array; mimetype: string; sniffed: boolean }> {
  if (!attachment.eventId && !attachment.mxcUri) {
    throw new Error('Either mxcUri or eventId must be provided');
  }
  if (attachment.mxcUri && !ALLOWED_URI_SCHEMES.test(attachment.mxcUri)) {
    throw new Error('Invalid URI scheme');
  }
  const maxBytes = opts.maxBytes ?? MAX_FILE_SIZE;
  if (attachment.size && attachment.size > maxBytes) {
    throw new AttachmentTooLargeError('File exceeds maximum size');
  }

  let bytes: Uint8Array;
  let httpType: string | undefined;
  if (attachment.eventId || attachment.mxcUri!.startsWith('mxc://')) {
    const bound = boundedSignal(
      opts.signal,
      opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
    );
    try {
      if (attachment.eventId) {
        if (!roomId)
          throw new Error(
            `Cannot fetch event ${attachment.eventId}: no Matrix room for this turn`,
          );
        const media = await untilAborted(
          source.downloadEvent(
            roomId,
            attachment.eventId,
            maxBytes,
            bound.signal,
          ),
          bound.signal,
        );
        if (!media)
          throw new Error(`Matrix event ${attachment.eventId} not found`);
        bytes = media.bytes;
        httpType = media.mimetype;
      } else {
        bytes = await untilAborted(
          source.downloadMxc(attachment.mxcUri!, maxBytes, bound.signal),
          bound.signal,
        );
      }
    } finally {
      bound.release();
    }
  } else {
    const result = await downloadFromUrl(attachment.mxcUri!, {
      ...opts,
      maxBytes,
    });
    bytes = result.data;
    httpType = result.contentType;
  }
  if (bytes.length > maxBytes) throw tooLarge(maxBytes);
  if (bytes.length === 0) throw new AttachmentRejectedError('File is empty');
  const sniffed = detectMimeFromMagicBytes(bytes);
  if (sniffed && containerMatchesClaim(sniffed, attachment.mimetype)) {
    return { bytes, mimetype: attachment.mimetype, sniffed: true };
  }
  return {
    bytes,
    mimetype:
      sniffed ??
      (httpType && httpType !== 'application/octet-stream'
        ? httpType
        : attachment.mimetype),
    sniffed: sniffed !== null,
  };
}

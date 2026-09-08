/**
 * Fetching attachment bytes — Matrix media (through the gateway, which holds
 * the authenticated client and the room keys) and plain `http(s)` URLs with
 * the Node runtime's SSRF guard, manual redirect validation and streaming
 * size cap.
 */
import { detectMimeFromMagicBytes } from './magic';
import type { AttachmentInput } from './types';

export const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB per file
export const MAX_TOTAL_SIZE = 50 * 1024 * 1024; // 50 MB across all attachments
export const ALLOWED_URI_SCHEMES = /^(mxc|https?):\/\//i;
const MAX_REDIRECT_COUNT = 5;
const DOWNLOAD_TIMEOUT_MS = 60_000;

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
 */
export interface MatrixMediaSource {
  /** Raw bytes behind an `mxc://` URI (authenticated media download). */
  downloadMxc(mxc: string): Promise<Uint8Array>;
  /**
   * Bytes of the media event `eventId` in `roomId`, decrypted when the event
   * carries an encrypted `file`. Null when the event does not exist.
   */
  downloadEvent(
    roomId: string,
    eventId: string,
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

/** A controller that aborts on `signal` OR after `timeoutMs`, whichever first. */
function boundedSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(onAbort, timeoutMs);
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
    if (!response || (response.status >= 300 && response.status < 400)) {
      throw new Error('Too many redirects');
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} downloading ${url}`);
    }
    const contentType =
      response.headers.get('content-type')?.split(';')[0]?.trim() ?? undefined;
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > maxBytes) {
      throw new Error(
        `File too large: server reports ${Math.round(parseInt(contentLength, 10) / 1024 / 1024)} MB (limit: ${Math.round(maxBytes / 1024 / 1024)} MB)`,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Response body is not readable');
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel();
        throw new Error(
          `File exceeds maximum size (${Math.round(maxBytes / 1024 / 1024)} MB) — download aborted`,
        );
      }
      chunks.push(value);
    }
    return {
      data: concat(chunks, total),
      contentType,
      ...(currentUrl !== url ? { finalUrl: currentUrl } : {}),
    };
  } finally {
    bound.release();
  }
}

/**
 * Bytes for one attachment from whichever source it names, with the per-file
 * cap enforced before and after the transfer. `mimetype` is the best-known
 * type: content sniffing, then the HTTP `content-type`, then the client's
 * claim.
 */
export async function loadAttachmentBytes(
  attachment: AttachmentInput,
  roomId: string | undefined,
  source: MatrixMediaSource,
  opts: DownloadOptions = {},
): Promise<{ bytes: Uint8Array; mimetype: string }> {
  if (!attachment.eventId && !attachment.mxcUri) {
    throw new Error('Either mxcUri or eventId must be provided');
  }
  if (attachment.mxcUri && !ALLOWED_URI_SCHEMES.test(attachment.mxcUri)) {
    throw new Error('Invalid URI scheme');
  }
  const maxBytes = opts.maxBytes ?? MAX_FILE_SIZE;
  if (attachment.size && attachment.size > maxBytes) {
    throw new Error('File exceeds maximum size');
  }

  let bytes: Uint8Array;
  let httpType: string | undefined;
  if (attachment.eventId) {
    if (!roomId)
      throw new Error(
        `Cannot fetch event ${attachment.eventId}: no Matrix room for this turn`,
      );
    const media = await source.downloadEvent(roomId, attachment.eventId);
    if (!media) throw new Error(`Matrix event ${attachment.eventId} not found`);
    bytes = media.bytes;
    httpType = media.mimetype;
  } else if (attachment.mxcUri!.startsWith('mxc://')) {
    bytes = await source.downloadMxc(attachment.mxcUri!);
  } else {
    const result = await downloadFromUrl(attachment.mxcUri!, {
      ...opts,
      maxBytes,
    });
    bytes = result.data;
    httpType = result.contentType;
  }
  if (bytes.length > maxBytes) {
    throw new Error('File exceeds maximum size');
  }
  const sniffed = detectMimeFromMagicBytes(bytes);
  return {
    bytes,
    mimetype:
      sniffed ??
      (httpType && httpType !== 'application/octet-stream'
        ? httpType
        : attachment.mimetype),
  };
}

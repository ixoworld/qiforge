/**
 * Files the person sent on an IXO Channels turn. The channel gateway keeps
 * each file and serves it from a signed link of its own,
 * `https://<gateway host>/media/<binding id>/<object id>?exp=…&kid=…&sig=…`,
 * valid for 30 days. That link is a bearer capability: it never enters
 * model context, hidden notes, stored message metadata or traces. The model,
 * the transcript and `view_attachment` name a channel file by an opaque
 * reference, `channel:<the first 16 hex digits of its sha256>`, and the
 * owner object resolves it to the link server-side (`ChannelMediaSource`):
 * from the turn's own list, else from the links it keeps for the session
 * (`ChannelAttachmentLinkStore`).
 *
 * A link is fetched only when it is the gateway's own (its origin is the
 * host of a `did:web` in `CHANNEL_SERVICE_DID` and its path lies under
 * `/media/<the binding the file came on>/`), without following redirects,
 * and the bytes are kept only when their SHA-256 is the one the gateway
 * sent. The file always goes to a model as these bytes, never by URL.
 */
import {
  AttachmentRejectedError,
  AttachmentTooLargeError,
  downloadFromUrl,
} from './download';

export const CHANNEL_REF_PREFIX = 'channel:';

/**
 * The gateway's per-file bound for a video or a document
 * (`maxLargeMediaBytes`, 50 MiB); photos are at most 16 MB there. A file
 * above `MAX_FILE_SIZE` is archived to the sandbox but never handed to a
 * model (see the pipeline).
 */
export const CHANNEL_MAX_FILE_BYTES = 52_428_800;

/** The opaque reference of a channel file: `channel:` + 16 hex digits of its sha256. */
export function channelAttachmentRef(sha256: string): string {
  return `${CHANNEL_REF_PREFIX}${sha256.slice(0, 16)}`;
}

export function isChannelAttachmentRef(ref: string): boolean {
  return /^channel:[0-9a-f]{16}$/.test(ref);
}

/** What the owner object knows of a channel file: never shown to a model. */
export interface ChannelMediaLink {
  url: string;
  /** Lowercase hex SHA-256 of the bytes the gateway serves. */
  sha256: string;
  /** The binding the file arrived on: its link lies under `/media/<bindingId>/`. */
  bindingId: string;
}

/**
 * A channel file the gateway could not serve as sent (the link expired,
 * was refused, or is not the gateway's own): noted, never retried, and
 * described without its link.
 */
export class ChannelFileUnavailableError extends AttachmentRejectedError {
  override readonly name: string = 'ChannelFileUnavailableError';
}

/** The https origins of the gateways allowed to call this deployment. */
export function channelMediaOrigins(
  channelServiceDids: readonly string[],
): string[] {
  const origins = new Set<string>();
  for (const did of channelServiceDids) {
    const host = /^did:web:([a-z0-9.-]+)$/.exec(did)?.[1];
    if (host) origins.add(`https://${host}`);
  }
  return [...origins];
}

/** Whether `link.url` is the gateway's own link for a file of `link.bindingId`. */
export function isGatewayMediaUrl(
  link: Pick<ChannelMediaLink, 'url' | 'bindingId'>,
  origins: readonly string[],
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(link.url);
  } catch {
    return false;
  }
  const prefix = `/media/${link.bindingId}/`;
  return (
    parsed.protocol === 'https:' &&
    !parsed.username &&
    !parsed.password &&
    origins.includes(parsed.origin) &&
    parsed.pathname.startsWith(prefix) &&
    parsed.pathname.length > prefix.length &&
    !parsed.pathname.slice(prefix.length).includes('/')
  );
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/**
 * The bytes of a channel file. Every failure is described without the
 * link: a refused or expired link, a redirect or a transport error is
 * `ChannelFileUnavailableError`, and so are bytes whose SHA-256 is not the
 * one the gateway sent; a file over `maxBytes` stays an
 * `AttachmentTooLargeError`, and an abort keeps its reason.
 */
export async function downloadChannelFile(
  link: ChannelMediaLink,
  opts: {
    origins: readonly string[];
    maxBytes: number;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<{ bytes: Uint8Array; contentType?: string }> {
  if (!isGatewayMediaUrl(link, opts.origins))
    throw new ChannelFileUnavailableError(
      'its link is not one this channel gateway serves',
    );
  let result: Awaited<ReturnType<typeof downloadFromUrl>>;
  try {
    result = await downloadFromUrl(link.url, {
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      maxBytes: opts.maxBytes,
      maxRedirects: 0,
    });
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    if (error instanceof AttachmentTooLargeError) throw error;
    const status =
      error instanceof Error ? /^HTTP (\d{3}) /.exec(error.message)?.[1] : '';
    throw new ChannelFileUnavailableError(
      status
        ? `the channel gateway answered ${status}`
        : 'the channel gateway could not be reached',
    );
  }
  const digest = hex(await crypto.subtle.digest('SHA-256', result.data));
  if (digest !== link.sha256)
    throw new ChannelFileUnavailableError(
      'its bytes do not match the digest the channel sent',
    );
  return {
    bytes: result.data,
    ...(result.contentType ? { contentType: result.contentType } : {}),
  };
}

/** How the attachment layer reads a `channel:` reference (built by the owner object). */
export interface ChannelMediaSource {
  load(
    ref: string,
    opts: {
      maxBytes: number;
      fetchImpl?: typeof fetch;
      signal?: AbortSignal;
      timeoutMs?: number;
    },
  ): Promise<{ bytes: Uint8Array; contentType?: string }>;
}

/**
 * A `ChannelMediaSource` over `resolve` (the turn's files, then the
 * session's stored links) for the gateways in `origins`.
 */
export function createChannelMediaSource(input: {
  resolve: (ref: string) => Promise<ChannelMediaLink | undefined>;
  origins: readonly string[];
}): ChannelMediaSource {
  return {
    load: async (ref, opts) => {
      const link = await input.resolve(ref);
      if (!link)
        throw new ChannelFileUnavailableError(
          'it is no longer available here; ask the person to send it again',
        );
      return downloadChannelFile(link, { ...opts, origins: input.origins });
    },
  };
}

/**
 * The sandbox archive name of a channel file: the cleaned name with the
 * first 12 hex digits of its digest before the extension
 * (`photo-0123456789ab.jpg`), so two photos the gateway names alike never
 * overwrite each other.
 */
export function channelArchiveName(safeName: string, ref: string): string {
  const tag = ref.slice(
    CHANNEL_REF_PREFIX.length,
    CHANNEL_REF_PREFIX.length + 12,
  );
  const dot = safeName.lastIndexOf('.');
  return dot > 0
    ? `${safeName.slice(0, dot)}-${tag}${safeName.slice(dot)}`
    : `${safeName}-${tag}`;
}

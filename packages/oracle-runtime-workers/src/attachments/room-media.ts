/**
 * Files the person sent on an IXO Channels turn, posted as Matrix media
 * events in the session's thread of their encrypted oracle room — so the
 * room (Qi.Space) shows the photo or document next to the mirrored text,
 * and the turn names the file by its media event like any Matrix upload.
 *
 * Everything runs in the user's own object; the shared Matrix gateway only
 * carries the small event send. One pass over the gateway's link:
 *
 *   gateway link ─▶ check (size, SHA-256, plaintext copy) ─▶ [AES-CTR] ─▶ FixedLengthStream ─▶ POST /_matrix/media/v3/upload
 *
 * The check is a transform in that single pipeline rather than a `tee()`: a
 * tee buffers for its slower branch, so a fast hash branch would queue the
 * whole file for a slow upload branch. Inline, memory stays O(chunk) plus
 * the plaintext copy, kept only for a file the model lane may read
 * (`MAX_FILE_SIZE`). The check holds the latest chunk back until the
 * stream ends, then releases it only when the byte count and the SHA-256
 * are the gateway's: a file that is not what the gateway announced never
 * completes its upload, and no event is sent for it.
 *
 * The upload uses the oracle's crypto-less plugin device (the same account,
 * `MatrixGatewayObject.botCredentials`); the event is sent by the gateway's
 * E2EE device through the user object's room mirror (`RoomMirror.sendMedia`),
 * serialised with the session's text mirrors. Failures never reach the turn:
 * the caller logs them (without the link) and the file is read from the
 * gateway as before.
 */
import { createAttachmentEncryptor } from '@ixo/matrix-bot-workers-sdk';
import type {
  MediaMessage,
  MediaMirrorSend,
  MirrorOrigin,
} from '../do/room-mirror';
import { matrixTxnId } from '../matrix/txn-id';
import type { Logger } from '../plugin-api/types';
import {
  CHANNEL_MAX_FILE_BYTES,
  ChannelFileUnavailableError,
  hex,
  isGatewayMediaUrl,
  type ChannelMediaLink,
} from './channel';
import {
  abortError,
  boundedSignal,
  DOWNLOAD_TIMEOUT_MS,
  MAX_FILE_SIZE,
  MAX_TOTAL_SIZE,
  untilAborted,
} from './download';
import { sanitizeAttachmentFilename } from './sanitize';

/** Upper bound on posting all of one turn's files; what is left then is read from the gateway as before. */
export const CHANNEL_MEDIA_TURN_TIMEOUT_MS = 120_000;
/** Files of one turn posted at the same time. */
export const CHANNEL_MEDIA_CONCURRENCY = 3;

export type ChannelFileKind = 'image' | 'video' | 'document' | 'audio';

const MSGTYPES: Record<ChannelFileKind, MediaMessage['msgtype']> = {
  image: 'm.image',
  video: 'm.video',
  audio: 'm.audio',
  document: 'm.file',
};

/** One channel file as the gateway announced it. */
export interface ChannelThreadFile {
  /** Its `channel:` reference. */
  ref: string;
  link: ChannelMediaLink;
  filename: string;
  mimetype: string;
  /** Exact byte length the gateway serves. */
  size: number;
  kind: ChannelFileKind;
}

/** Where the files go: the session's thread in the user's oracle room. */
export interface ThreadMediaTarget {
  roomId: string;
  /** The session's marker event (the session id). */
  threadId: string;
  origin?: MirrorOrigin;
  /** Megolm room: the file is encrypted (`EncryptedFile` v2) before upload. */
  encrypted: boolean;
}

/** The plugin device's homeserver and access token. */
export interface MediaHomeserver {
  baseUrl: string;
  accessToken: string;
}

export interface ThreadMediaDeps {
  /** The https origins of this deployment's channel gateways. */
  origins: readonly string[];
  homeserver: MediaHomeserver;
  /** Send the event (in session order); resolves with its event id. */
  send(event: MediaMirrorSend, signal: AbortSignal): Promise<string>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Per-file deadline, from opening the link to the event id (default `DOWNLOAD_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** The largest file whose plaintext is kept for the model lane (default `MAX_FILE_SIZE`). */
  keepMaxBytes?: number;
  /** The homeserver rejected the access token (401): the caller fetches it again next time. */
  onUnauthorized?: () => void;
}

/** A file posted to the thread. */
export interface ThreadMedia {
  eventId: string;
  mxc: string;
  /** The plaintext, when the file is at most `keepMaxBytes`. */
  bytes?: Uint8Array;
  /** The gateway's content type, else the announced one. */
  mimetype: string;
}

/** The homeserver refused or failed the upload (`status` when it answered). */
export class ChannelMediaUploadError extends Error {
  override readonly name: string = 'ChannelMediaUploadError';

  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The size and digest check, inline in the upload pipeline (see the module
 * comment): counts and hashes every chunk, copies it when `keep`, and
 * withholds the latest chunk until the end proves the file is the
 * announced one. `failure()` is the first refusal, for a caller whose
 * upload failed because of it.
 */
function verifiedPassThrough(expected: {
  size: number;
  sha256: string;
  keep: boolean;
}): {
  transform: TransformStream<Uint8Array, Uint8Array>;
  plaintext: () => Uint8Array | undefined;
  failure: () => Error | null;
} {
  const digest = new crypto.DigestStream('SHA-256');
  const hash = digest.getWriter();
  let copy: Uint8Array | null = expected.keep
    ? new Uint8Array(expected.size)
    : null;
  let seen = 0;
  let held: Uint8Array | null = null;
  let failure: Error | null = null;
  let verified = false;
  const refuse = (reason: string): Error => {
    failure ??= new ChannelFileUnavailableError(reason);
    copy = null;
    return failure;
  };
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      if (seen + chunk.byteLength > expected.size)
        throw refuse('it is larger than the channel announced');
      copy?.set(chunk, seen);
      seen += chunk.byteLength;
      await hash.write(chunk);
      if (held) controller.enqueue(held);
      held = chunk;
    },
    async flush(controller) {
      if (seen !== expected.size)
        throw refuse('it is smaller than the channel announced');
      await hash.close();
      if (hex(await digest.digest) !== expected.sha256)
        throw refuse('its bytes do not match the digest the channel sent');
      verified = true;
      if (held) controller.enqueue(held);
      held = null;
    },
  });
  return {
    transform,
    plaintext: () => (verified ? (copy ?? undefined) : undefined),
    failure: () => failure,
  };
}

/** The file's name in the room: the cleaned name, or its kind when nothing is left. */
function roomFilename(file: ChannelThreadFile): string {
  const cleaned = sanitizeAttachmentFilename(file.filename).trim();
  return cleaned || (file.kind === 'image' ? 'photo' : file.kind);
}

/**
 * Stream one channel file from the gateway's link to the homeserver
 * (encrypted in a Megolm room) and post it as a media event in the session
 * thread. Throws, without the link in the message, when the link is not
 * the gateway's, the file is not the one announced, the upload or the send
 * fails, or the deadline passes; no event is sent then.
 */
export async function uploadChannelFileToThread(
  file: ChannelThreadFile,
  target: ThreadMediaTarget,
  txnId: string,
  deps: ThreadMediaDeps,
): Promise<ThreadMedia> {
  if (!isGatewayMediaUrl(file.link, deps.origins))
    throw new ChannelFileUnavailableError(
      'its link is not one this channel gateway serves',
    );
  if (
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    file.size > CHANNEL_MAX_FILE_BYTES
  )
    throw new ChannelFileUnavailableError(
      `its announced size (${file.size} bytes) is outside 1..${CHANNEL_MAX_FILE_BYTES}`,
    );
  const fetchImpl = deps.fetchImpl ?? fetch;
  const bound = boundedSignal(
    deps.signal,
    deps.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
    'Posting the file to the session thread',
  );
  // Stops the gateway → homeserver pipe: at the deadline, or when the
  // upload ends without reading it all.
  const pipe = new AbortController();
  const stopPipe = (): void => pipe.abort(bound.signal.reason);
  bound.signal.addEventListener('abort', stopPipe, { once: true });
  try {
    let source: Response;
    try {
      source = await fetchImpl(file.link.url, {
        signal: bound.signal,
        redirect: 'manual',
      });
    } catch {
      if (bound.signal.aborted) throw abortError(bound.signal);
      throw new ChannelFileUnavailableError(
        'the channel gateway could not be reached',
      );
    }
    if (!source.ok || !source.body) {
      await source.body?.cancel().catch(() => undefined);
      throw new ChannelFileUnavailableError(
        `the channel gateway answered ${source.status}`,
      );
    }
    const contentType = source.headers
      .get('content-type')
      ?.split(';')[0]
      ?.trim();

    const check = verifiedPassThrough({
      size: file.size,
      sha256: file.link.sha256,
      keep: file.size <= (deps.keepMaxBytes ?? MAX_FILE_SIZE),
    });
    const encryptor = target.encrypted ? createAttachmentEncryptor() : null;
    const checked = source.body.pipeThrough(check.transform);
    // CTR keeps the length, so the ciphertext is `size` bytes too; the
    // fixed-length stream gives the upload its Content-Length and fails it
    // if the stream ends short or runs long.
    const fixed = new FixedLengthStream(file.size);
    const piped = (
      encryptor ? checked.pipeThrough(encryptor.transform) : checked
    )
      .pipeTo(fixed.writable, { signal: pipe.signal })
      .then(
        () => null,
        (error: unknown) => error,
      );

    const uploadUrl = new URL(
      '/_matrix/media/v3/upload',
      deps.homeserver.baseUrl,
    );
    const filename = roomFilename(file);
    uploadUrl.searchParams.set('filename', filename);
    let upload: Response;
    try {
      upload = await fetchImpl(uploadUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${deps.homeserver.accessToken}`,
          // An encrypted upload never names the file's type outside the event.
          'content-type': encryptor
            ? 'application/octet-stream'
            : file.mimetype,
        },
        body: fixed.readable,
        signal: bound.signal,
      });
    } catch (error) {
      pipe.abort(error);
      // A refusal of the check fails the upload request (it errors the body).
      const refused = check.failure();
      if (refused) throw refused;
      if (bound.signal.aborted) throw abortError(bound.signal);
      const pipeError = await untilAborted(piped, bound.signal);
      if (pipeError)
        throw new ChannelFileUnavailableError(
          'the channel gateway stopped sending it',
        );
      throw new ChannelMediaUploadError(
        `the homeserver could not be reached: ${errorText(error)}`,
      );
    }
    if (!upload.ok) {
      if (upload.status === 401) deps.onUnauthorized?.();
      pipe.abort(new Error('upload refused'));
      await untilAborted(piped, bound.signal);
      const refused = check.failure();
      if (refused) throw refused;
      const detail = (await upload.text().catch(() => ''))
        .replace(/\s+/g, ' ')
        .slice(0, 200);
      throw new ChannelMediaUploadError(
        `the homeserver refused the upload: ${upload.status}${detail ? ` ${detail}` : ''}`,
        upload.status,
      );
    }
    const answer: unknown = await upload.json().catch(() => null);
    const mxc =
      typeof answer === 'object' &&
      answer !== null &&
      'content_uri' in answer &&
      typeof answer.content_uri === 'string' &&
      answer.content_uri.startsWith('mxc://')
        ? answer.content_uri
        : null;
    if (!mxc)
      throw new ChannelMediaUploadError(
        'the homeserver answered the upload without a content_uri',
      );
    // The homeserver answered after the last byte: the pipe has ended and
    // the check has passed (it withholds that byte otherwise).
    const pipeError = await untilAborted(piped, bound.signal);
    const refused = check.failure();
    if (refused) throw refused;
    if (pipeError)
      throw new ChannelFileUnavailableError(
        'the channel gateway stopped sending it',
      );

    const media: MediaMessage = {
      msgtype: MSGTYPES[file.kind],
      body: filename,
      filename,
      info: { mimetype: file.mimetype, size: file.size },
      ...(encryptor
        ? { file: { url: mxc, ...(await encryptor.info) } }
        : { url: mxc }),
    };
    const eventId = await untilAborted(
      deps.send(
        {
          roomId: target.roomId,
          threadId: target.threadId,
          txnId,
          ...(target.origin ? { origin: target.origin } : {}),
          media,
        },
        bound.signal,
      ),
      bound.signal,
    );
    const bytes = check.plaintext();
    return {
      eventId,
      mxc,
      ...(bytes ? { bytes } : {}),
      mimetype:
        contentType && contentType !== 'application/octet-stream'
          ? contentType
          : file.mimetype,
    };
  } finally {
    bound.signal.removeEventListener('abort', stopPipe);
    bound.release();
  }
}

/** The transaction id of a turn's `index`-th file event: fixed, so a retried send is deduplicated. */
export function channelMediaTxnId(
  sessionId: string,
  requestId: string,
  index: number,
): string {
  return matrixTxnId('media', sessionId, requestId, String(index));
}

/**
 * Post a turn's files to the session thread, `CHANNEL_MEDIA_CONCURRENCY` at
 * a time, within `CHANNEL_MEDIA_TURN_TIMEOUT_MS` for all of them (and the
 * per-file deadline for each). A file sent twice in one message is posted
 * once. Plaintext copies are kept in turn order while they fit the turn's
 * download budget (`MAX_TOTAL_SIZE`, what the pipeline would read anyway),
 * so the copies of one turn never exceed it. Returns what was posted, by
 * reference; a file that could not be is logged once, without its link,
 * and left out.
 */
export async function postChannelFilesToThread(input: {
  files: readonly ChannelThreadFile[];
  target: ThreadMediaTarget;
  sessionId: string;
  requestId: string;
  deps: ThreadMediaDeps & {
    turnTimeoutMs?: number;
    concurrency?: number;
    /** The most plaintext the turn keeps across its files (default `MAX_TOTAL_SIZE`). */
    keepTotalBytes?: number;
    log: Pick<Logger, 'log' | 'warn'>;
  };
}): Promise<Map<string, ThreadMedia>> {
  const { deps } = input;
  const keepMax = deps.keepMaxBytes ?? MAX_FILE_SIZE;
  const queue: Array<{
    file: ChannelThreadFile;
    index: number;
    keep: boolean;
  }> = [];
  const seen = new Set<string>();
  let kept = 0;
  input.files.forEach((file, index) => {
    if (seen.has(file.ref)) return;
    seen.add(file.ref);
    const keep =
      file.size <= keepMax &&
      kept + file.size <= (deps.keepTotalBytes ?? MAX_TOTAL_SIZE);
    if (keep) kept += file.size;
    queue.push({ file, index, keep });
  });
  const posted = new Map<string, ThreadMedia>();
  if (queue.length === 0) return posted;
  const startedAt = Date.now();
  const turn = boundedSignal(
    deps.signal,
    deps.turnTimeoutMs ?? CHANNEL_MEDIA_TURN_TIMEOUT_MS,
    "Posting the turn's files to the session thread",
  );
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const { file, index, keep } = next;
      try {
        if (turn.signal.aborted) throw abortError(turn.signal);
        posted.set(
          file.ref,
          await uploadChannelFileToThread(
            file,
            input.target,
            channelMediaTxnId(input.sessionId, input.requestId, index),
            { ...deps, signal: turn.signal, keepMaxBytes: keep ? keepMax : 0 },
          ),
        );
      } catch (error) {
        deps.log.warn(
          `[attachments] channel file ${file.ref} (${file.kind}, ${file.size} bytes) not posted to thread ${input.sessionId}; the turn reads it from the channel gateway: ${errorText(error)}`,
        );
      }
    }
  };
  try {
    await Promise.all(
      Array.from(
        {
          length: Math.min(
            deps.concurrency ?? CHANNEL_MEDIA_CONCURRENCY,
            queue.length,
          ),
        },
        worker,
      ),
    );
  } finally {
    turn.release();
  }
  deps.log.log(
    `[attachments] posted ${posted.size}/${seen.size} channel file(s) to thread ${input.sessionId} in ${Date.now() - startedAt} ms`,
  );
  return posted;
}

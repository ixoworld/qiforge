/**
 * Files the person sent on an IXO Channels turn, posted as encrypted Matrix
 * media events in the session's thread of their oracle room — so the room
 * (Qi.Space) shows the photo or document next to the mirrored text, and the
 * file outlives the gateway's 30-day link (`channel-links.ts` keeps the
 * event; `download.ts` reads the room copy once the link fails).
 *
 * Everything heavy runs in the user's own object; the shared Matrix gateway
 * only carries the small event send. One pass over the gateway's link:
 *
 *   gateway link ─▶ check (size, SHA-256, head, plaintext copy) ─▶ AES-CTR ─▶ FixedLengthStream ─▶ POST /_matrix/media/v3/upload
 *
 * The check is a transform in that single pipeline rather than a `tee()`: a
 * tee buffers for its slower branch, so a fast hash branch would queue the
 * whole file for a slow upload branch. Inline, memory stays O(chunk) plus
 * the plaintext copy, kept only for a file the model may read directly (an
 * image, or a document of at most `NATIVE_DOCUMENT_MAX_BYTES`) and only
 * while the turn's copies stay within `CHANNEL_MEDIA_KEEP_TOTAL_BYTES`. The
 * check holds the latest chunk back until the stream ends, then releases it
 * only when the byte count and the SHA-256 are the gateway's: a file that
 * is not what the gateway announced never completes its upload.
 *
 * The turn never waits for the homeserver or the room. The copy of each kept
 * file resolves the moment the check passes (before the upload's answer);
 * the turn's wait for it is bounded by the per-file read deadline and the
 * turn's read deadline, and a copy that does not come leaves the file to be
 * read from the gateway as before. Once the read has passed the check, the
 * upload has its own deadline (`CHANNEL_MEDIA_UPLOAD_TIMEOUT_MS`) and the
 * event is sent later by the owner object, in file order on the session's
 * mirror chain (`RoomMirror.sendMedia`).
 *
 * Only a Megolm room gets a file (the owner object checks; the gateway
 * refuses to send an attachment key into a room it does not see as
 * encrypted). The upload carries no file name and an
 * `application/octet-stream` type, so the homeserver operator learns only
 * the size; the name and the type live in the encrypted event, the type
 * taken from the file's own bytes (`roomMediaType`). The upload uses the
 * oracle's crypto-less plugin device (`MatrixGatewayObject.botCredentials`).
 */
import { createAttachmentEncryptor } from '@ixo/matrix-bot-workers-sdk';
import { channelRequestHash } from '../channels/contract';
import type { MediaMessage } from '../do/room-mirror';
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
  untilAborted,
} from './download';
import { containerMatchesClaim, detectMimeFromMagicBytes } from './magic';
import { NATIVE_DOCUMENT_MAX_BYTES } from './route';
import { sanitizeAttachmentFilename } from './sanitize';

/** Upper bound on reading all of one turn's files; a file not read by then is read from the gateway as before. */
export const CHANNEL_MEDIA_TURN_TIMEOUT_MS = 120_000;
/** Upper bound on the homeserver's answer once a file has been read and checked. */
export const CHANNEL_MEDIA_UPLOAD_TIMEOUT_MS = 60_000;
/**
 * How long a turn's file events wait for the mirror pass to queue the
 * person's text ahead of them on the session chain; past it they are queued
 * anyway (and the room may show them before the text).
 */
export const CHANNEL_MEDIA_TEXT_WAIT_MS = 60_000;
/**
 * Upper bound on one file event in the background, from being queued on the
 * session chain to its event id (the wait for the text, the upload, earlier
 * mirrors, the send and its retries); past it nothing more is attempted.
 */
export const CHANNEL_MEDIA_SEND_TIMEOUT_MS = 300_000;
/** Files of one turn uploaded at the same time. */
export const CHANNEL_MEDIA_CONCURRENCY = 3;
/** The most plaintext one turn keeps for the model across its files (16 MiB). */
export const CHANNEL_MEDIA_KEEP_TOTAL_BYTES = 16 * 1024 * 1024;
/** Files one user may have posted to their room per UTC day. */
export const CHANNEL_MEDIA_DAILY_FILES = 200;
/** Bytes one user may have posted to their room per UTC day (1 GiB). */
export const CHANNEL_MEDIA_DAILY_BYTES = 1024 * 1024 * 1024;

export type ChannelFileKind = 'image' | 'video' | 'document' | 'audio';

/** One channel file as the gateway announced it. */
export interface ChannelThreadFile {
  /** Its `channel:` reference. */
  ref: string;
  /** Its position in the person's message (the event's transaction id). */
  index: number;
  link: ChannelMediaLink;
  filename: string;
  mimetype: string;
  /** Exact byte length the gateway serves. */
  size: number;
  kind: ChannelFileKind;
}

/** The plugin device's homeserver and access token. */
export interface MediaHomeserver {
  baseUrl: string;
  accessToken: string;
}

/** A file's verified plaintext, for the turn's model lane. */
export interface ThreadFileCopy {
  bytes: Uint8Array;
  /** The gateway's content type, else the announced one. */
  mimetype: string;
}

/** One file in flight: what the turn may read, and what the room will show. */
export interface ChannelFileUpload {
  file: ChannelThreadFile;
  /**
   * The verified plaintext, resolved as soon as the check passes (before the
   * upload's answer) for a kept file; null for any other, or when the read
   * failed or ran out of time. Never rejects, and stays resolved when the
   * upload fails afterwards.
   */
  copy: Promise<ThreadFileCopy | null>;
  /** The event content once the homeserver holds the file; rejects (without the link) when it does not. */
  uploaded: Promise<MediaMessage>;
}

export interface ChannelUploadDeps {
  /** The https origins of this deployment's channel gateways. */
  origins: readonly string[];
  homeserver: MediaHomeserver;
  fetchImpl?: typeof fetch;
  /** Per-file deadline on the read, from opening the link to the check passing (default `DOWNLOAD_TIMEOUT_MS`). */
  readTimeoutMs?: number;
  /** Deadline on the homeserver's answer once the read has passed (default `CHANNEL_MEDIA_UPLOAD_TIMEOUT_MS`). */
  uploadTimeoutMs?: number;
  /** The homeserver rejected `accessToken` (401): the caller asks for fresh credentials. */
  onUnauthorized?: (accessToken: string) => void;
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

/** A promise with its settle functions (ES2024 `Promise.withResolvers`). */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason: unknown) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Enough leading bytes for every signature `detectMimeFromMagicBytes` knows. */
const HEAD_BYTES = 16;

/**
 * The size and digest check, inline in the upload pipeline (see the module
 * comment): counts and hashes every chunk, keeps the first bytes for the
 * type, copies the file when `keep`, and withholds the latest chunk until
 * the end proves the file is the announced one. `onVerified` runs then,
 * before that chunk goes on (so before the upload can be answered), with
 * the copy when one was kept. `failure()` is the first refusal, for a
 * caller whose upload failed because of it.
 */
function verifiedPassThrough(expected: {
  size: number;
  sha256: string;
  keep: boolean;
  onVerified: (copy: Uint8Array | null, head: Uint8Array) => void;
}): {
  transform: TransformStream<Uint8Array, Uint8Array>;
  failure: () => Error | null;
} {
  const digest = new crypto.DigestStream('SHA-256');
  const hash = digest.getWriter();
  let copy: Uint8Array | null = expected.keep
    ? new Uint8Array(expected.size)
    : null;
  const head = new Uint8Array(Math.min(HEAD_BYTES, expected.size));
  let seen = 0;
  let held: Uint8Array | null = null;
  let failure: Error | null = null;
  const refuse = (reason: string): Error => {
    failure ??= new ChannelFileUnavailableError(reason);
    copy = null;
    return failure;
  };
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      // An empty chunk carries nothing, and held back it would release the
      // real last chunk before the check.
      if (chunk.byteLength === 0) return;
      if (seen + chunk.byteLength > expected.size)
        throw refuse('it is larger than the channel announced');
      if (seen < head.length)
        head.set(chunk.subarray(0, head.length - seen), seen);
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
      const kept = copy;
      // The turn owns the copy from here; the pipeline lets go of it.
      copy = null;
      expected.onVerified(kept, head);
      if (held) controller.enqueue(held);
      held = null;
    },
  });
  return { transform, failure: () => failure };
}

/** Raster images a Matrix client shows inline (`m.image`). */
const RASTER_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** Types a file event may name; anything else is `application/octet-stream`. */
const ROOM_TYPES = new Set([
  ...RASTER_TYPES,
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/3gpp',
  'audio/mpeg',
  'audio/ogg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/flac',
  'audio/webm',
  'audio/wav',
  'audio/x-wav',
  'application/pdf',
]);

/**
 * The type and msgtype of the file event, from the file's own first bytes
 * (`detectMimeFromMagicBytes`): the claim is kept only when it is the more
 * precise name of the sniffed container (`containerMatchesClaim`: an
 * `audio/mp4` voice note in an ISO-BMFF box); bytes no signature matches,
 * and any type outside the allowlist, are `application/octet-stream`.
 * `m.image` only for a raster image; video and audio by their type; every
 * other file is `m.file`.
 */
export function roomMediaType(
  head: Uint8Array,
  claimed: string,
): { mimetype: string; msgtype: MediaMessage['msgtype'] } {
  const claim = (claimed.split(';')[0] ?? '').trim().toLowerCase();
  const sniffed = detectMimeFromMagicBytes(head);
  const named = sniffed
    ? containerMatchesClaim(sniffed, claim)
      ? claim
      : sniffed
    : null;
  const mimetype =
    named && ROOM_TYPES.has(named) ? named : 'application/octet-stream';
  const msgtype: MediaMessage['msgtype'] = RASTER_TYPES.has(mimetype)
    ? 'm.image'
    : mimetype.startsWith('video/')
      ? 'm.video'
      : mimetype.startsWith('audio/')
        ? 'm.audio'
        : 'm.file';
  return { mimetype, msgtype };
}

/** The file's name in the room: the cleaned name, or its kind when nothing is left. */
function roomFilename(file: ChannelThreadFile): string {
  const cleaned = sanitizeAttachmentFilename(file.filename).trim();
  return cleaned || (file.kind === 'image' ? 'photo' : file.kind);
}

/**
 * Stream one channel file from the gateway's link to the homeserver,
 * encrypted for a Megolm room (`EncryptedFile` v2), and build its event
 * content. `keep` asks for the verified plaintext (`copy`). `readSignal`
 * (the turn's read deadline) stops a read that has not passed its check;
 * after the check only the upload deadline applies. Nothing is sent here.
 */
export function uploadChannelFile(
  file: ChannelThreadFile,
  deps: ChannelUploadDeps & { keep: boolean; readSignal?: AbortSignal },
): ChannelFileUpload {
  const copy = deferred<ThreadFileCopy | null>();
  const uploaded = streamUpload(file, deps, (kept) => copy.resolve(kept));
  // Whatever happened, a copy that has not come by the end never will.
  void uploaded.then(
    () => copy.resolve(null),
    () => copy.resolve(null),
  );
  return { file, copy: copy.promise, uploaded };
}

async function streamUpload(
  file: ChannelThreadFile,
  deps: ChannelUploadDeps & { keep: boolean; readSignal?: AbortSignal },
  onCopy: (copy: ThreadFileCopy | null) => void,
): Promise<MediaMessage> {
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
  // One controller stops the gateway read, the pipe and the upload: the
  // read's deadlines until the check passes, the upload's after it.
  const stop = new AbortController();
  const read = boundedSignal(
    deps.readSignal,
    deps.readTimeoutMs ?? DOWNLOAD_TIMEOUT_MS,
    'Reading the channel file',
  );
  let uploadTimer: ReturnType<typeof setTimeout> | undefined;
  let verified = false;
  const onReadAbort = (): void => {
    if (!verified) stop.abort(read.signal.reason);
  };
  read.signal.addEventListener('abort', onReadAbort, { once: true });
  let head: Uint8Array = new Uint8Array(0);
  try {
    let source: Response;
    try {
      source = await fetchImpl(file.link.url, {
        signal: stop.signal,
        redirect: 'manual',
      });
    } catch {
      if (stop.signal.aborted) throw abortError(stop.signal);
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
    const mimetype =
      contentType && contentType !== 'application/octet-stream'
        ? contentType
        : file.mimetype;

    const check = verifiedPassThrough({
      size: file.size,
      sha256: file.link.sha256,
      keep: deps.keep,
      onVerified: (kept, first) => {
        verified = true;
        head = first;
        read.signal.removeEventListener('abort', onReadAbort);
        read.release();
        const uploadMs =
          deps.uploadTimeoutMs ?? CHANNEL_MEDIA_UPLOAD_TIMEOUT_MS;
        uploadTimer = setTimeout(
          () =>
            stop.abort(
              new Error(
                `Uploading the file to the homeserver timed out after ${Math.round(uploadMs / 1000)} s`,
              ),
            ),
          uploadMs,
        );
        onCopy(kept ? { bytes: kept, mimetype } : null);
      },
    });
    const encryptor = createAttachmentEncryptor();
    // CTR keeps the length, so the ciphertext is `size` bytes too; the
    // fixed-length stream gives the upload its Content-Length and fails it
    // if the stream ends short or runs long.
    const fixed = new FixedLengthStream(file.size);
    const piped = source.body
      .pipeThrough(check.transform)
      .pipeThrough(encryptor.transform)
      .pipeTo(fixed.writable, { signal: stop.signal })
      .then(
        () => null,
        (error: unknown) => error,
      );

    let answer: Response;
    try {
      // No `filename` and no type: the homeserver sees only ciphertext.
      answer = await fetchImpl(
        new URL('/_matrix/media/v3/upload', deps.homeserver.baseUrl),
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${deps.homeserver.accessToken}`,
            'content-type': 'application/octet-stream',
          },
          body: fixed.readable,
          signal: stop.signal,
        },
      );
    } catch (error) {
      const timedOut = stop.signal.aborted;
      stop.abort(error);
      // A refusal of the check fails the upload request (it errors the body).
      const refused = check.failure();
      if (refused) throw refused;
      if (timedOut) throw abortError(stop.signal);
      if ((await piped) && !verified)
        throw new ChannelFileUnavailableError(
          'the channel gateway stopped sending it',
        );
      throw new ChannelMediaUploadError(
        `the homeserver could not be reached: ${errorText(error)}`,
      );
    }
    if (!answer.ok) {
      if (answer.status === 401)
        deps.onUnauthorized?.(deps.homeserver.accessToken);
      stop.abort(new Error('upload refused'));
      await piped;
      const refused = check.failure();
      if (refused) throw refused;
      const detail = (await answer.text().catch(() => ''))
        .replace(/\s+/g, ' ')
        .slice(0, 200);
      throw new ChannelMediaUploadError(
        `the homeserver refused the upload: ${answer.status}${detail ? ` ${detail}` : ''}`,
        answer.status,
      );
    }
    const json: unknown = await answer.json().catch(() => null);
    const mxc =
      typeof json === 'object' &&
      json !== null &&
      'content_uri' in json &&
      typeof json.content_uri === 'string' &&
      json.content_uri.startsWith('mxc://')
        ? json.content_uri
        : null;
    if (!mxc)
      throw new ChannelMediaUploadError(
        'the homeserver answered the upload without a content_uri',
      );
    // The homeserver answered after the last byte: the pipe has ended and
    // the check has passed (it withholds that byte otherwise).
    const pipeError = await untilAborted(piped, stop.signal);
    const refused = check.failure();
    if (refused) throw refused;
    if (pipeError || !verified)
      throw new ChannelFileUnavailableError(
        'the channel gateway stopped sending it',
      );
    const name = roomFilename(file);
    const type = roomMediaType(head, file.mimetype);
    return {
      msgtype: type.msgtype,
      body: name,
      filename: name,
      info: { mimetype: type.mimetype, size: file.size },
      file: { url: mxc, ...(await encryptor.info) },
    };
  } finally {
    read.signal.removeEventListener('abort', onReadAbort);
    read.release();
    clearTimeout(uploadTimer);
  }
}

/**
 * The transaction id of a turn's `index`-th file event: fixed, so a retried
 * send is deduplicated, and — like the channel text mirrors' — a hash, so
 * the request id never reaches the homeserver.
 */
export async function channelMediaTxnId(input: {
  userDid: string;
  bindingId: string;
  requestId: string;
  index: number;
}): Promise<string> {
  return `channel-${await channelRequestHash(
    JSON.stringify([
      input.userDid,
      input.bindingId,
      input.requestId,
      'file',
      input.index,
    ]),
  )}`;
}

/** The user object's storage key of `ChannelMediaDay`. */
export const CHANNEL_MEDIA_DAY_KEY = 'channel-media-day';

/** What one user posted to their room on one UTC day. */
export interface ChannelMediaDay {
  /** `YYYY-MM-DD` (UTC). */
  day: string;
  files: number;
  bytes: number;
}

/**
 * The per-user daily cap on posted files: `files` in order while the day's
 * count stays within `CHANNEL_MEDIA_DAILY_FILES` and its bytes within
 * `CHANNEL_MEDIA_DAILY_BYTES` (`usage` from another day starts afresh).
 * Returns the files to post, the ones left to the gateway, and the usage to
 * store (the admitted files counted: an upload spends its bandwidth whether
 * or not its event is sent).
 */
export function admitToDailyCap(
  files: readonly ChannelThreadFile[],
  usage: ChannelMediaDay | undefined,
  now: number,
): {
  admitted: ChannelThreadFile[];
  refused: ChannelThreadFile[];
  usage: ChannelMediaDay;
} {
  const day = new Date(now).toISOString().slice(0, 10);
  const next: ChannelMediaDay =
    usage?.day === day ? { ...usage } : { day, files: 0, bytes: 0 };
  const admitted: ChannelThreadFile[] = [];
  const refused: ChannelThreadFile[] = [];
  for (const file of files) {
    if (
      next.files + 1 > CHANNEL_MEDIA_DAILY_FILES ||
      next.bytes + file.size > CHANNEL_MEDIA_DAILY_BYTES
    ) {
      refused.push(file);
      continue;
    }
    next.files += 1;
    next.bytes += file.size;
    admitted.push(file);
  }
  return { admitted, refused, usage: next };
}

/**
 * Whether the turn keeps `file`'s plaintext: one the model may read
 * directly (an image of at most `MAX_FILE_SIZE`, or a document of at most
 * `NATIVE_DOCUMENT_MAX_BYTES`), in turn order while the copies stay within
 * `keepTotalBytes`. Every other file is read by the extract lane when its
 * turn comes, as without a room post.
 */
export function channelFilesToKeep(
  files: readonly ChannelThreadFile[],
  keepTotalBytes = CHANNEL_MEDIA_KEEP_TOTAL_BYTES,
): Set<string> {
  const keep = new Set<string>();
  let total = 0;
  for (const file of files) {
    const direct =
      (file.kind === 'image' && file.size <= MAX_FILE_SIZE) ||
      (file.kind === 'document' && file.size <= NATIVE_DOCUMENT_MAX_BYTES);
    if (!direct || total + file.size > keepTotalBytes) continue;
    keep.add(file.ref);
    total += file.size;
  }
  return keep;
}

/**
 * Start the uploads of a turn's (distinct) files, `CHANNEL_MEDIA_CONCURRENCY`
 * at a time, every read within `turnTimeoutMs` (default
 * `CHANNEL_MEDIA_TURN_TIMEOUT_MS`) of the start and the per-file deadline;
 * the files in `keep` (`channelFilesToKeep`) hand their plaintext to the
 * turn. Returns at once, one entry per file in message order; `done`
 * settles when every upload has. A file that cannot be uploaded is logged
 * once, without its link. A 429 from the homeserver skips the files not yet
 * started.
 */
export function startChannelFileUploads(input: {
  files: readonly ChannelThreadFile[];
  sessionId: string;
  deps: ChannelUploadDeps & {
    keep: ReadonlySet<string>;
    turnTimeoutMs?: number;
    concurrency?: number;
    log: Pick<Logger, 'log' | 'warn'>;
  };
}): { uploads: ChannelFileUpload[]; done: Promise<void> } {
  const { deps, files } = input;
  const keep = deps.keep;
  const slots = files.map((file) => ({
    file,
    copy: deferred<ThreadFileCopy | null>(),
    uploaded: deferred<MediaMessage>(),
  }));
  for (const slot of slots) slot.uploaded.promise.catch(() => undefined);
  const uploads: ChannelFileUpload[] = slots.map((slot) => ({
    file: slot.file,
    copy: slot.copy.promise,
    uploaded: slot.uploaded.promise,
  }));
  if (slots.length === 0) return { uploads, done: Promise.resolve() };

  const startedAt = Date.now();
  const turn = boundedSignal(
    undefined,
    deps.turnTimeoutMs ?? CHANNEL_MEDIA_TURN_TIMEOUT_MS,
    "Reading the turn's channel files",
  );
  const queue = [...slots];
  let rateLimited = false;
  let posted = 0;
  const worker = async (): Promise<void> => {
    for (let slot = queue.shift(); slot; slot = queue.shift()) {
      const { file } = slot;
      if (rateLimited || turn.signal.aborted) {
        const reason = rateLimited
          ? 'the homeserver rate-limited this turn'
          : errorText(abortError(turn.signal));
        slot.copy.resolve(null);
        slot.uploaded.reject(new ChannelMediaUploadError(reason));
        deps.log.warn(
          `[attachments] channel file ${file.ref} (${file.kind}, ${file.size} bytes) not posted to thread ${input.sessionId}: ${reason}`,
        );
        continue;
      }
      const upload = uploadChannelFile(file, {
        ...deps,
        keep: keep.has(file.ref),
        readSignal: turn.signal,
      });
      slot.copy.resolve(upload.copy);
      try {
        slot.uploaded.resolve(await upload.uploaded);
        posted += 1;
      } catch (error) {
        if (error instanceof ChannelMediaUploadError && error.status === 429)
          rateLimited = true;
        slot.uploaded.reject(error);
        deps.log.warn(
          `[attachments] channel file ${file.ref} (${file.kind}, ${file.size} bytes) not posted to thread ${input.sessionId}: ${errorText(error)}`,
        );
      }
    }
  };
  const done = Promise.all(
    Array.from(
      {
        length: Math.min(
          deps.concurrency ?? CHANNEL_MEDIA_CONCURRENCY,
          slots.length,
        ),
      },
      worker,
    ),
  )
    .then(() => {
      deps.log.log(
        `[attachments] uploaded ${posted}/${slots.length} channel file(s) of thread ${input.sessionId} in ${Date.now() - startedAt} ms`,
      );
    })
    .finally(() => turn.release());
  return { uploads, done };
}

/**
 * `POST /channels/media`: the files of a web chat binding's history, read
 * back once the channel gateway no longer keeps them (it keeps a file 31
 * days). Two kinds, both served from the person's own object:
 *
 * - `file`: a file the PERSON sent, from the encrypted copy posted in the
 *   session thread (`attachments/room-media.ts`). What reading it needs
 *   (mxc, `EncryptedFile` fields, size) is kept with its link row, so the
 *   shared Matrix gateway object is not called; only a copy recorded before
 *   that was kept asks it once (`eventMediaInfo`, at most 15 s). The bytes
 *   come from the homeserver and are decrypted here, then streamed to
 *   the caller chunk by chunk under the reader's demand (a byte stream with
 *   no queue of its own), the size and the SHA-256 the gateway announced
 *   checked on the way. The last chunk is held back until both match, so a
 *   file that is not the one sent never arrives whole: its body fails.
 * - `artifact`: a document the oracle made (`create_artifact`), from the
 *   user's own `artifacts` row, as the same envelope the share link's
 *   ciphertext opens to (`ArtifactEnvelope`). No share link is read, made
 *   or extended: it works after the link has expired or was revoked.
 *
 * An object serves one read at a time (`ChannelMediaSlot`): a second one is
 * `429 busy` at once, never queued. Every read ends within
 * `CHANNEL_MEDIA_DEADLINE_MS`, and the slot is released on every path: the
 * last byte, a refusal, a failed check, an upstream error, the deadline or
 * the caller cancelling the body. One log line per read, with its kind,
 * outcome, bytes and duration, never a name, a reference or an id.
 */
import { z } from 'zod';
import type { EventMediaInfo } from '../do/contracts';
import type { ArtifactEnvelope } from '../artifacts/crypto';
import { ARTIFACT_ID_RE, type StoredArtifact } from '../artifacts/store';
import { hex, isChannelAttachmentRef } from '../attachments/channel';
import {
  abortError,
  boundedSignal,
  HomeserverMediaError,
  untilAborted,
} from '../attachments/download';
import {
  ChannelError,
  ChannelHistoryBody,
  channelRequestHash,
} from './contract';

/** The largest file or document this route serves (25 MiB). */
export const CHANNEL_MEDIA_MAX_BYTES = 25 * 1024 * 1024;
/**
 * Upper bound on one read, from the request to the last byte: under the
 * gateway's own 55 s, so the object ends a read before its caller gives up.
 */
export const CHANNEL_MEDIA_DEADLINE_MS = 50_000;
/**
 * Upper bound on the one `eventMediaInfo` call a room copy recorded before
 * its media info was kept needs (the shared gateway object).
 */
export const CHANNEL_MEDIA_EVENT_LOOKUP_TIMEOUT_MS = 15_000;
/**
 * Upper bound on everything before the answer's headers (the object's boot,
 * the ownership reads, the legacy event lookup, opening the homeserver
 * download): under the gateway's 40 s wait for headers, so a read the
 * gateway gave up on never holds the person's slot. Past it the read is
 * `504 timeout` at once; the 50 s deadline still bounds the whole read.
 */
export const CHANNEL_MEDIA_HEADERS_DEADLINE_MS = 35_000;
/** What a caller refused with a 503 is told to wait, in seconds. */
export const CHANNEL_MEDIA_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;
/** What a caller refused with `busy` is told to wait, in seconds. */
export const CHANNEL_MEDIA_BUSY_RETRY_AFTER_SECONDS = 2;
/** What a caller refused with `rate_limited` is told to wait, in seconds (the limiter's period). */
export const CHANNEL_MEDIA_RATE_LIMIT_RETRY_AFTER_SECONDS = 60;
/** The largest media request body (bytes). */
export const CHANNEL_MEDIA_BODY_MAX_BYTES = 4096;

/**
 * A session id as the Auth Hub accepts it in a media grant: 1-255 printable
 * ASCII characters, no space (every form the runtime mints: `$<event id>`,
 * `s_<uuid>`), so the canonical JSON is the same bytes on both sides.
 */
const SessionIdText = z.string().regex(/^[\x21-\x7e]{1,255}$/);

/** What one media read asks for: a person's file or an oracle's document, in one session. */
export const ChannelMediaQuery = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('file'),
    sessionId: SessionIdText,
    ref: z.string().refine(isChannelAttachmentRef),
  }),
  z.strictObject({
    kind: z.literal('artifact'),
    sessionId: SessionIdText,
    artifactId: z.string().regex(ARTIFACT_ID_RE),
  }),
]);
export type ChannelMediaQuery = z.infer<typeof ChannelMediaQuery>;

/**
 * The canonical JSON of a media query, as the person's device signs it and
 * the Auth Hub hashes it into the grant's `nb.queryHash`: its three keys in
 * alphabetical order, no spaces, each value a JSON string
 * (`JSON.stringify`). Byte for byte:
 *
 * - file: `{"kind":"file","ref":"channel:0123456789abcdef","sessionId":"$abc"}`
 * - artifact: `{"artifactId":"<32 hex>","kind":"artifact","sessionId":"$abc"}`
 *
 * No key of a history query (`after`, `before`, `limit`) ever appears, and
 * every history query has `limit`: a history grant's hash never equals a
 * media query's, nor the other way round.
 */
export function canonicalMediaQuery(query: ChannelMediaQuery): string {
  return query.kind === 'file'
    ? `{"kind":"file","ref":${JSON.stringify(query.ref)},"sessionId":${JSON.stringify(query.sessionId)}}`
    : `{"artifactId":${JSON.stringify(query.artifactId)},"kind":"artifact","sessionId":${JSON.stringify(query.sessionId)}}`;
}

/** Lower-case hex SHA-256 of `canonicalMediaQuery` (UTF-8): the grant's `nb.queryHash`. */
export function mediaQueryHash(query: ChannelMediaQuery): Promise<string> {
  return channelRequestHash(canonicalMediaQuery(query));
}

/** `POST /channels/media`: the binding fields of a history read, and the media query. */
export const ChannelMediaBody = z.strictObject({
  provider: ChannelHistoryBody.shape.provider,
  bindingId: ChannelHistoryBody.shape.bindingId,
  bindingRevision: ChannelHistoryBody.shape.bindingRevision,
  requestId: ChannelHistoryBody.shape.requestId,
  query: ChannelMediaQuery,
});
export type ChannelMediaInput = z.infer<typeof ChannelMediaBody>;

/** A refusal's machine-readable code (the body is `{ "error": code }`). */
export type ChannelMediaErrorCode =
  | 'not_found'
  | 'too_large'
  | 'busy'
  | 'upstream'
  | 'timeout';

export type ChannelMediaFailure = {
  ok: false;
  status: number;
  error: ChannelMediaErrorCode | ChannelError['code'];
  /** Seconds, for a 429. */
  retryAfter?: number;
};

/** What the user object answers a media read with (across RPC). */
export type ChannelMediaOutcome =
  | {
      ok: true;
      kind: 'file';
      /** The plaintext, a byte stream; fails before its end when a check fails. */
      body: ReadableStream<Uint8Array>;
      /** Plaintext bytes, from the event (the body is checked against it). */
      size: number;
      mime: string;
      name: string;
      /** Lower-case hex SHA-256 of the plaintext (the body is checked against it). */
      sha256: string;
    }
  | { ok: true; kind: 'artifact'; json: string }
  | ChannelMediaFailure;

const failure = (
  status: number,
  error: ChannelMediaFailure['error'],
  retryAfter?: number,
): ChannelMediaFailure => ({
  ok: false,
  status,
  error,
  ...(retryAfter !== undefined ? { retryAfter } : {}),
});

/** One read in flight per user object; a second is refused, never queued. */
export class ChannelMediaSlot {
  private held = false;

  /** A release function (safe to call more than once), or null when a read is in flight. */
  tryAcquire(): (() => void) | null {
    if (this.held) return null;
    this.held = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.held = false;
    };
  }

  get busy(): boolean {
    return this.held;
  }
}

/** The room copy of a person's file, as the link store keeps it for its session. */
export interface ChannelFileRoomCopy {
  eventId: string;
  /** Lower-case hex SHA-256 of the plaintext the gateway announced (checked when it was posted). */
  sha256: string;
  /**
   * What reading the event needs (mxc, `EncryptedFile` fields, type, name,
   * size), kept when it was posted. Absent for a copy posted before it was
   * kept: that one is read through `eventMediaInfo` once.
   */
  media?: EventMediaInfo;
}

/** What a media read needs of the user's object. */
export interface ChannelMediaSource {
  /** Whether the binding owns `sessionId` (one of its history sessions). */
  ownsSession(sessionId: string): Promise<boolean>;
  /** The room copy of `ref` in `sessionId` that arrived on this binding, if one was posted. */
  fileRoomCopy(
    sessionId: string,
    ref: string,
  ): Promise<ChannelFileRoomCopy | undefined>;
  /** The Matrix room the session's thread lives in. */
  sessionRoom(sessionId: string): Promise<string | undefined>;
  /**
   * ONE call on the shared Matrix gateway object, for a room copy recorded
   * without its media info only: the event's small JSON, never its bytes.
   * Null only when the event is gone (unknown or redacted); a failure throws.
   */
  eventMediaInfo(
    roomId: string,
    eventId: string,
    timeoutMs: number,
  ): Promise<EventMediaInfo | null>;
  /** The media on the homeserver, as stored (ciphertext for an encrypted event). */
  openMedia(
    mxc: string,
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>>;
  /** Plaintext out of the stored ciphertext (`createAttachmentDecryptor`). */
  decryptor(
    file: NonNullable<EventMediaInfo['file']>,
  ): TransformStream<Uint8Array, Uint8Array>;
  /** The user's artefact row, or undefined (also when the store is not bound). */
  artifact(artifactId: string): Promise<StoredArtifact | undefined>;
}

/** How a read ended, for its log line. */
export type ChannelMediaReadOutcome =
  | 'ok'
  | 'aborted'
  | 'timeout'
  | 'size_mismatch'
  | 'hash_mismatch'
  | 'upstream'
  | ChannelMediaFailure['error'];

/** The one log line of a read: no name, reference, session, event or person. */
export function logChannelMediaRead(fields: {
  kind: ChannelMediaQuery['kind'];
  outcome: ChannelMediaReadOutcome;
  bytes: number;
  ms: number;
}): void {
  const line = `[channels] media read ${JSON.stringify(fields)}`;
  // eslint-disable-next-line no-console -- console IS the logger on Workers (Logs/observability).
  if (fields.outcome === 'ok') console.log(line);
  // eslint-disable-next-line no-console -- console IS the logger on Workers (Logs/observability).
  else console.warn(line);
}

class MediaCheckError extends Error {
  constructor(readonly outcome: 'size_mismatch' | 'hash_mismatch') {
    super(
      outcome === 'size_mismatch'
        ? 'channel media: the file is not the size its event names'
        : 'channel media: the file does not match its SHA-256',
    );
    this.name = 'MediaCheckError';
  }
}

/**
 * `source` as a byte stream read on demand (no queue: a chunk is read from
 * upstream only when the caller asks for one), checked on the way: never
 * more than `size` bytes, exactly `size` at the end, and the SHA-256 of all
 * of them `sha256`. The latest chunk is held back until the end proves the
 * file, so a mismatch errors the stream before its last bytes. `signal`
 * (the read's deadline) errors it and cancels upstream. `onEnd` runs
 * exactly once, however it ends: the last byte delivered, a failed check or
 * upstream read, the signal, or the caller cancelling.
 */
export function verifiedMediaStream(opts: {
  source: ReadableStream<Uint8Array>;
  size: number;
  sha256: string;
  signal: AbortSignal;
  onEnd: (end: { outcome: ChannelMediaReadOutcome; bytes: number }) => void;
}): ReadableStream<Uint8Array> {
  const reader = opts.source.getReader();
  const digest = new crypto.DigestStream('SHA-256');
  // Rejects when the hash is aborted (a read that did not end with its
  // last byte), where nothing awaits it.
  digest.digest.catch(() => undefined);
  const hash = digest.getWriter();
  let seen = 0;
  let held: Uint8Array | null = null;
  let ended = false;
  let controller: ReadableByteStreamController | null = null;
  const end = (outcome: ChannelMediaReadOutcome): void => {
    if (ended) return;
    ended = true;
    held = null;
    opts.signal.removeEventListener('abort', onAbort);
    if (outcome !== 'ok') hash.abort().catch(() => undefined);
    opts.onEnd({ outcome, bytes: seen });
  };
  const stop = (outcome: ChannelMediaReadOutcome, reason: Error): void => {
    if (ended) return;
    end(outcome);
    try {
      controller?.error(reason);
    } catch {
      // Already closed or errored.
    }
    reader.cancel(reason).catch(() => undefined);
  };
  function onAbort(): void {
    stop('timeout', abortError(opts.signal));
  }
  return new ReadableStream(
    {
      type: 'bytes',
      start(c) {
        controller = c;
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      },
      async pull(c) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (ended) return;
            if (done) {
              if (seen !== opts.size)
                throw new MediaCheckError('size_mismatch');
              await hash.close();
              if (hex(await digest.digest) !== opts.sha256)
                throw new MediaCheckError('hash_mismatch');
              if (ended) return;
              if (held) c.enqueue(held);
              held = null;
              c.close();
              end('ok');
              return;
            }
            if (value.byteLength === 0) continue;
            if (seen + value.byteLength > opts.size)
              throw new MediaCheckError('size_mismatch');
            seen += value.byteLength;
            // A byte stream takes ownership of what it is given: hand it a
            // copy, never the upstream chunk (which the hash reads too).
            const copy = value.slice();
            await hash.write(value);
            if (ended) return;
            const previous = held;
            held = copy;
            if (previous) {
              c.enqueue(previous);
              return;
            }
          }
        } catch (error) {
          stop(
            error instanceof MediaCheckError ? error.outcome : 'upstream',
            error instanceof MediaCheckError
              ? error
              : new Error('channel media: the file could not be read'),
          );
        }
      },
      cancel(reason) {
        if (ended) return;
        end('aborted');
        reader.cancel(reason).catch(() => undefined);
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * One media read of a web binding (the shell verified the grant and checked
 * the binding with the Auth Hub). The object's `slot` is taken first, before
 * anything else runs: a read already in flight answers `429 busy` at once.
 * `prepare` then readies the object and returns its source (a
 * `ChannelError` it throws is the refusal). Everything not this binding's,
 * or not there, is the same `404 not_found`: an unowned session, a
 * reference or artefact of another session, a file with no room copy, a
 * deleted session. The slot is released exactly once, when the read has
 * ended: at once for a refusal or a document, at the body's end for a file.
 */
export async function serveChannelMedia(
  query: ChannelMediaQuery,
  opts: {
    slot: ChannelMediaSlot;
    prepare: () => Promise<ChannelMediaSource>;
    deadlineMs?: number;
    headersDeadlineMs?: number;
    lookupTimeoutMs?: number;
    now?: () => number;
  },
): Promise<ChannelMediaOutcome> {
  const now = opts.now ?? Date.now;
  const deadlineMs = opts.deadlineMs ?? CHANNEL_MEDIA_DEADLINE_MS;
  const headersDeadlineMs = Math.min(
    opts.headersDeadlineMs ?? CHANNEL_MEDIA_HEADERS_DEADLINE_MS,
    deadlineMs,
  );
  const lookupTimeoutMs =
    opts.lookupTimeoutMs ?? CHANNEL_MEDIA_EVENT_LOOKUP_TIMEOUT_MS;
  const started = now();
  const log = (outcome: ChannelMediaReadOutcome, bytes: number): void =>
    logChannelMediaRead({
      kind: query.kind,
      outcome,
      bytes,
      ms: Math.max(0, now() - started),
    });
  const release = opts.slot.tryAcquire();
  if (!release) {
    log('busy', 0);
    return failure(429, 'busy', CHANNEL_MEDIA_BUSY_RETRY_AFTER_SECONDS);
  }
  const bound = boundedSignal(undefined, deadlineMs, 'Channel media read');
  let handedOff = false;
  // Every step before the answer's headers: the whole read's deadline, or
  // the headers' own, whichever comes first.
  const beforeHeaders = boundedSignal(
    bound.signal,
    headersDeadlineMs,
    'Channel media read before its headers',
  );
  // The homeserver download: cut at the headers' deadline while the answer
  // has not started, at the whole read's afterwards.
  const download = new AbortController();
  const onDeadline = (): void => download.abort(bound.signal.reason);
  bound.signal.addEventListener('abort', onDeadline, { once: true });
  const onHeadersDeadline = (): void => {
    if (!handedOff) download.abort(beforeHeaders.signal.reason);
  };
  beforeHeaders.signal.addEventListener('abort', onHeadersDeadline, {
    once: true,
  });
  const finish = (outcome: ChannelMediaReadOutcome, bytes: number): void => {
    beforeHeaders.release();
    beforeHeaders.signal.removeEventListener('abort', onHeadersDeadline);
    bound.signal.removeEventListener('abort', onDeadline);
    bound.release();
    release();
    log(outcome, bytes);
  };
  const refuse = (refusal: ChannelMediaFailure): ChannelMediaFailure => {
    finish(refusal.error, 0);
    return refusal;
  };
  const step = <T>(work: Promise<T>): Promise<T> =>
    untilAborted(work, beforeHeaders.signal);
  try {
    const source = await step(opts.prepare());
    if (!(await step(source.ownsSession(query.sessionId))))
      return refuse(failure(404, 'not_found'));
    if (query.kind === 'artifact') {
      const stored = await step(source.artifact(query.artifactId));
      if (!stored || stored.sessionId !== query.sessionId)
        return refuse(failure(404, 'not_found'));
      if (stored.ref.bytes > CHANNEL_MEDIA_MAX_BYTES)
        return refuse(failure(413, 'too_large'));
      const envelope: ArtifactEnvelope = {
        v: 1,
        title: stored.ref.title,
        mime: stored.ref.mime,
        content: stored.content,
        createdAt: stored.createdAt,
      };
      const json = JSON.stringify(envelope);
      finish('ok', new TextEncoder().encode(json).byteLength);
      return { ok: true, kind: 'artifact', json };
    }
    const copy = await step(source.fileRoomCopy(query.sessionId, query.ref));
    const roomId = copy
      ? await step(source.sessionRoom(query.sessionId))
      : undefined;
    if (!copy || !roomId) return refuse(failure(404, 'not_found'));
    let info: EventMediaInfo | null | undefined = copy.media;
    if (!info) {
      // A copy recorded before its media info was kept: one bounded lookup
      // on the shared gateway object. A failure or a timeout is never "not
      // found": only an event that is gone is.
      const lookup = boundedSignal(
        beforeHeaders.signal,
        lookupTimeoutMs,
        'Channel media event lookup',
      );
      try {
        info = await untilAborted(
          source.eventMediaInfo(
            roomId,
            copy.eventId,
            Math.max(
              1,
              Math.min(lookupTimeoutMs, deadlineMs - (now() - started)),
            ),
          ),
          lookup.signal,
        );
      } catch (error) {
        if (beforeHeaders.signal.aborted) throw error;
        return refuse(
          lookup.signal.aborted
            ? failure(504, 'timeout')
            : failure(502, 'upstream'),
        );
      } finally {
        lookup.release();
      }
    }
    if (!info) return refuse(failure(404, 'not_found'));
    const size = info.size;
    // Every room copy names its size (`room-media.ts`): one that does not is
    // not a copy this runtime posted.
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)
      return refuse(failure(502, 'upstream'));
    if (size > CHANNEL_MEDIA_MAX_BYTES)
      return refuse(failure(413, 'too_large'));
    let stored: ReadableStream<Uint8Array>;
    try {
      stored = await step(source.openMedia(info.mxc, download.signal));
    } catch (error) {
      if (beforeHeaders.signal.aborted) throw error;
      return refuse(
        error instanceof HomeserverMediaError && error.status === 404
          ? failure(404, 'not_found')
          : failure(502, 'upstream'),
      );
    }
    let plain: ReadableStream<Uint8Array>;
    try {
      plain = info.file
        ? stored.pipeThrough(source.decryptor(info.file))
        : stored;
    } catch {
      stored.cancel().catch(() => undefined);
      return refuse(failure(502, 'upstream'));
    }
    const body = verifiedMediaStream({
      source: plain,
      size,
      sha256: copy.sha256,
      signal: bound.signal,
      onEnd: ({ outcome, bytes }) => finish(outcome, bytes),
    });
    handedOff = true;
    // The answer starts now: from here only the whole read's deadline holds.
    beforeHeaders.release();
    beforeHeaders.signal.removeEventListener('abort', onHeadersDeadline);
    return {
      ok: true,
      kind: 'file',
      body,
      size,
      mime: info.mimetype || 'application/octet-stream',
      name: info.filename || 'file',
      sha256: copy.sha256,
    };
  } catch (error) {
    if (handedOff) throw error;
    if (beforeHeaders.signal.aborted) {
      download.abort(beforeHeaders.signal.reason);
      return refuse(failure(504, 'timeout'));
    }
    if (error instanceof ChannelError)
      return refuse(failure(error.status, error.code));
    finish('upstream', 0);
    throw error;
  }
}

/** The refusal body of the media route: `{ "error": code }`, `Retry-After` on a 429 or a 503. */
export function channelMediaErrorResponse(refusal: {
  status: number;
  error: string;
  retryAfter?: number;
}): Response {
  const retryAfter =
    refusal.retryAfter ??
    (refusal.status === 503
      ? CHANNEL_MEDIA_UNAVAILABLE_RETRY_AFTER_SECONDS
      : undefined);
  return new Response(JSON.stringify({ error: refusal.error }), {
    status: refusal.status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(retryAfter !== undefined
        ? { 'retry-after': String(retryAfter) }
        : {}),
    },
  });
}

/** A media type as a header carries it, else `application/octet-stream`. */
function headerMediaType(mime: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/.test(
    mime,
  )
    ? mime
    : 'application/octet-stream';
}

/** The name percent-encoded as UTF-8 (a lone surrogate becomes U+FFFD, never a throw). */
function encodedFileName(name: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(name))
    out += /[A-Za-z0-9\-_.!~*'()]/.test(String.fromCharCode(byte))
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  return out;
}

/**
 * The HTTP answer for a user object's outcome. A file goes out with its
 * exact length (`FixedLengthStream`: the body fails if it ends short or
 * runs over), its type, its name (percent-encoded UTF-8, `x-ixo-file-name`)
 * and its SHA-256 (`x-ixo-sha256`); a document as its JSON envelope. The
 * headers are built before the body is handed on: if they cannot be, the
 * object's body is cancelled at once (freeing its read slot) and the answer
 * is `502 upstream`.
 */
export function channelMediaResponse(outcome: ChannelMediaOutcome): Response {
  if (!outcome.ok) return channelMediaErrorResponse(outcome);
  if (outcome.kind === 'artifact')
    return new Response(outcome.json, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  let headers: Headers;
  let fixed: FixedLengthStream;
  try {
    headers = new Headers({
      'content-type': headerMediaType(outcome.mime),
      'content-length': String(outcome.size),
      'x-ixo-file-name': encodedFileName(outcome.name),
      'x-ixo-sha256': outcome.sha256,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
    fixed = new FixedLengthStream(outcome.size);
  } catch {
    outcome.body.cancel().catch(() => undefined);
    return channelMediaErrorResponse({ status: 502, error: 'upstream' });
  }
  outcome.body.pipeTo(fixed.writable).catch(() => undefined);
  return new Response(fixed.readable, { headers });
}

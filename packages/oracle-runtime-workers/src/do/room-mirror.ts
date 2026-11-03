import {
  channelOrigin,
  type ChannelReplyReference,
} from '../channels/contract';
/**
 * The room mirror of HTTP chats: every Portal turn is replayed into the
 * user's oracle room as a thread under the session's marker event, the user
 * message when the turn starts and the reply when it ends (Node's
 * `MessagesService`). Node fires these and forgets them; on Workers the
 * gateway object is replaced on every deploy and can be drained at any time,
 * so a mirror sent at that instant fails with a transport error and, unless
 * retried, is gone for good — the room transcript then disagrees with the
 * Portal's for ever.
 *
 * Two rules make the retry safe:
 * - each send carries a transaction id derived from the session, the request
 *   and the author, so a send whose response was lost is deduplicated by the
 *   homeserver rather than posted twice;
 * - sends are serialised per session (parallel across sessions), so a reply
 *   being retried can never overtake the message it answers, and a later
 *   turn's mirrors queue behind an earlier turn's.
 *
 * The same chain carries the media events of a channel turn's files
 * (`sendMedia`, built by `attachments/room-media.ts`): each is posted after
 * the mirrors queued before it and before the reply.
 */
import type { EncryptedFileInfo } from '@ixo/matrix-bot-workers-sdk';
import { matrixTxnId } from '../matrix/txn-id';
import { retryGateway, type RetryGatewayOptions } from './gateway-retry';

export type MirrorAuthor = 'user' | 'oracle';

export function mirrorTxnId(
  sessionId: string,
  requestId: string,
  who: MirrorAuthor,
): string {
  return matrixTxnId(
    'replay',
    sessionId,
    requestId,
    who === 'user' ? 'u' : 'o',
  );
}

export interface MirrorSend {
  roomId: string;
  body: string;
  formattedBody?: string;
  /** The session's marker event — the thread the mirror is posted under. */
  threadId: string;
  txnId: string;
  origin?: {
    provider: string;
    bindingId: string;
    remoteMessageRef: string;
    replyTo?: ChannelReplyReference;
  };
}

/** The `org.ixo.qi.origin` input of a channel mirror. */
export type MirrorOrigin = NonNullable<MirrorSend['origin']>;

/**
 * The media part of an `m.room.message` file event (`m.image` / `m.video` /
 * `m.audio` / `m.file`): what the room shows, without the thread relation
 * and the channel origin, which `mediaEventContent` adds.
 */
export interface MediaMessage {
  msgtype: 'm.image' | 'm.video' | 'm.audio' | 'm.file';
  body: string;
  filename: string;
  info: { mimetype: string; size: number };
  /** An encrypted attachment: its `mxc://` plus the `EncryptedFile` fields. */
  file?: { url: string } & EncryptedFileInfo;
  /** A plain attachment (a room that is not end-to-end encrypted). */
  url?: string;
}

export interface MediaMirrorSend {
  roomId: string;
  /** The session's marker event — the thread the file is posted under. */
  threadId: string;
  txnId: string;
  origin?: MirrorOrigin;
  media: MediaMessage;
}

export interface RoomMirrorDeps {
  sendText(send: MirrorSend): Promise<string>;
  /** Send one timeline event (`content` JSON-encoded) with a pinned transaction id; returns its event id. */
  sendEvent(roomId: string, content: string, txnId: string): Promise<string>;
  /** Keeps the (un-awaited) send alive past the request that started it: `ctx.waitUntil`. */
  keepAlive(work: Promise<unknown>): void;
  log(message: string): void;
  warn(message: string): void;
  /** Retry policy override (tests shrink the delays). */
  retry?: Pick<RetryGatewayOptions, 'delaysMs' | 'sleep' | 'isTransient'>;
}

/** The relation that posts an event in the thread of `threadId` (with the reply fallback for clients without threads). */
function threadRelation(threadId: string) {
  return {
    rel_type: 'm.thread',
    event_id: threadId,
    is_falling_back: true,
    'm.in_reply_to': { event_id: threadId },
  };
}

export function mirrorEventContent(send: MirrorSend) {
  return {
    msgtype: 'm.text',
    body: send.body,
    ...(send.formattedBody
      ? { format: 'org.matrix.custom.html', formatted_body: send.formattedBody }
      : {}),
    'm.relates_to': threadRelation(send.threadId),
    ...(send.origin
      ? {
          'org.ixo.qi.origin': channelOrigin(send.origin),
          ...(send.origin.replyTo
            ? { 'org.ixo.qi.reply': send.origin.replyTo }
            : {}),
        }
      : {}),
  };
}

/**
 * A file event in the session thread: the media part, the thread relation
 * of the text mirrors and their `org.ixo.qi.origin` (never the quote, which
 * the text mirror of the same message carries).
 */
export function mediaEventContent(send: MediaMirrorSend) {
  return {
    ...send.media,
    'm.relates_to': threadRelation(send.threadId),
    ...(send.origin ? { 'org.ixo.qi.origin': channelOrigin(send.origin) } : {}),
  };
}

const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export class RoomMirror {
  /** Per session: the tail of its send chain. Removed once the chain drains. */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly deps: RoomMirrorDeps) {}

  /** Sessions with a mirror still in flight. */
  get pending(): number {
    return this.chains.size;
  }

  /**
   * Queue one mirror behind the session's previous ones. `prepare` runs when
   * the session's earlier mirrors have settled and resolves what to send
   * (`null` = nothing to mirror, e.g. no room). A mirror that cannot be
   * posted is logged and the chain moves on; a `required` one (a channel
   * request's, whose receipt records the delivery) rejects its caller
   * instead, and the chain still moves on.
   */
  enqueue(
    sessionId: string,
    prepare: () => Promise<MirrorSend | null>,
    label: string,
    required = false,
  ): Promise<void> {
    return this.chain(sessionId, async () => {
      try {
        const send = await prepare();
        if (send)
          await this.send(() => this.deps.sendText(send), send.threadId, label);
      } catch (err) {
        if (required) throw err;
        this.deps.warn(
          `[user-do] Matrix replay (${label}) failed — session=${sessionId}: ${errorText(err)}`,
        );
      }
    });
  }

  /**
   * Queue one file event behind the session's previous mirrors and resolve
   * with its event id; a send that fails (after the transient retries)
   * rejects. When `signal` has aborted by the time the event's turn in the
   * chain comes, nothing is sent and the call rejects with its reason: a
   * caller that stopped waiting never gets an event it no longer expects.
   */
  sendMedia(
    sessionId: string,
    send: MediaMirrorSend,
    label: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.chain(sessionId, () => {
      if (signal?.aborted)
        return Promise.reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error('the media send was abandoned'),
        );
      return this.send(
        () =>
          this.deps.sendEvent(
            send.roomId,
            JSON.stringify(mediaEventContent(send)),
            send.txnId,
          ),
        send.threadId,
        label,
      );
    });
  }

  /**
   * Run `work` once the session's previous mirrors have settled either way
   * (a required mirror that failed, and rejected its own caller, must not
   * skip the next one), keep it alive past the request, and drop the chain
   * once it drains.
   */
  private chain<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(sessionId) ?? Promise.resolve();
    // Settles (as `work` did) once the chain entry is gone, so a caller that
    // awaited it sees the session's chain drained.
    const done = previous
      .catch(() => undefined)
      .then(work)
      .finally(() => {
        if (this.chains.get(sessionId) === tracked)
          this.chains.delete(sessionId);
      });
    const tracked: Promise<void> = done.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(sessionId, tracked);
    this.deps.keepAlive(tracked);
    return done;
  }

  private async send(
    post: () => Promise<string>,
    threadId: string,
    label: string,
  ): Promise<string> {
    const eventId = await retryGateway(post, {
      ...this.deps.retry,
      onRetry: (err, attempt, delayMs) =>
        this.deps.warn(
          `[user-do] Matrix replay (${label}) send failed (attempt ${attempt}) — retrying in ${delayMs} ms with the same transaction id: ${errorText(err)}`,
        ),
    });
    this.deps.log(
      `[user-do] Matrix replay (${label}) → ${eventId} in thread ${threadId}`,
    );
    return eventId;
  }
}

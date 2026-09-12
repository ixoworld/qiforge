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
 */
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
}

export interface RoomMirrorDeps {
  sendText(send: MirrorSend): Promise<string>;
  /** Keeps the (un-awaited) send alive past the request that started it: `ctx.waitUntil`. */
  keepAlive(work: Promise<unknown>): void;
  log(message: string): void;
  warn(message: string): void;
  /** Retry policy override (tests shrink the delays). */
  retry?: Pick<RetryGatewayOptions, 'delaysMs' | 'sleep' | 'isTransient'>;
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
   * (`null` = nothing to mirror, e.g. no room). Never rejects: a mirror that
   * cannot be posted is logged and the chain moves on.
   */
  enqueue(
    sessionId: string,
    prepare: () => Promise<MirrorSend | null>,
    label: string,
  ): Promise<void> {
    const previous = this.chains.get(sessionId) ?? Promise.resolve();
    const tracked: Promise<void> = previous
      .then(() => prepare())
      .then((send) => (send ? this.send(send, label) : undefined))
      .catch((err: unknown) => {
        this.deps.warn(
          `[user-do] Matrix replay (${label}) failed — session=${sessionId}: ${errorText(err)}`,
        );
      })
      .finally(() => {
        if (this.chains.get(sessionId) === tracked)
          this.chains.delete(sessionId);
      });
    this.chains.set(sessionId, tracked);
    this.deps.keepAlive(tracked);
    return tracked;
  }

  private async send(send: MirrorSend, label: string): Promise<void> {
    const eventId = await retryGateway(() => this.deps.sendText(send), {
      ...this.deps.retry,
      onRetry: (err, attempt, delayMs) =>
        this.deps.warn(
          `[user-do] Matrix replay (${label}) send failed (attempt ${attempt}) — retrying in ${delayMs} ms with the same transaction id: ${errorText(err)}`,
        ),
    });
    this.deps.log(
      `[user-do] Matrix replay (${label}) → ${eventId} in thread ${send.threadId}`,
    );
  }
}

/**
 * Inbound message pipeline — the transport-agnostic half of the gateway.
 *
 * Mirrors the Node runtime's `MatrixListenerBridge` (per-thread debounce,
 * thread handling, attachments) with the room→user mapping the Workers
 * topology needs: each turn is dispatched to the user's own Durable Object,
 * so the sender must resolve to a user DID before anything else happens.
 * Own-message, stale and duplicate gating happens upstream, in the bot SDK's
 * pipeline; `gateway-do.ts` adapts its `BotMessage`s into `InboundMessage`s.
 *
 * Threads are sessions, exactly as on Node: the thread root of a message is
 * its session id (`reply-chain.ts` resolves it; a bare message is its own
 * root), the reply is posted into that thread, and a Portal session — whose
 * id is its marker event — is continued by replying inside its thread. The
 * main timeline of a room never carries a reply and is never a session.
 */

import { didToAliasPart } from '../do/contracts';

/** A media message (`m.image` / `m.file` / `m.audio` / `m.video`) as the turn sees it. */
export interface InboundAttachment {
  eventId: string;
  filename: string;
  mimetype: string;
  size?: number;
}

export interface InboundMessage {
  eventId: string;
  roomId: string;
  /** Full Matrix user id of the sender (`@did-ixo-…:server`). */
  sender: string;
  /** `origin_server_ts`. */
  ts: number;
  /** Text body; empty for a media-only message. */
  body: string;
  /**
   * The message's thread root: the `m.thread` root, the root of a quote-reply
   * chain (`gateway-do.ts` resolves it before the offer), or — for a bare
   * message — nothing: the message roots its own thread (`threadRootIdOf`).
   */
  threadRootId?: string;
  /** Present for media messages — fetched and decrypted at turn time. */
  attachment?: InboundAttachment;
  /** The bot is in the message's `m.mentions` (the group-chat gate answers a mention). */
  mentionsBot?: boolean;
  /** The event a quote-reply answers (`m.in_reply_to`); a reply to the bot's own message is answered too. */
  inReplyTo?: string;
}

export interface IngestTurn {
  userDid: string;
  matrixUserId: string;
  roomId: string;
  /** The thread the reply goes to: the message's root, or the message itself. */
  threadId: string;
  /** The thread root event id — the session is the thread (Node parity). */
  sessionId: string;
  /** Debounced messages joined with newlines, oldest first. */
  message: string;
  eventIds: string[];
  /**
   * The message the turn's metadata comes from — the latest text message of
   * the burst, else its first (Node's `sourceEvent`): its mentions and reply
   * target drive the group-chat gate, its timestamp dates the turn.
   */
  sourceEventId: string;
  ts: number;
  mentionsBot: boolean;
  inReplyTo?: string;
  /** Media shared in the same debounce window, oldest first. */
  attachments?: InboundAttachment[];
}

export interface IngestDeps {
  /** The DID that forms the oracle half of the user↔oracle room alias. */
  oracleDid: string;
  /**
   * The bot's Matrix user id. Its first occurrence in a message is rewritten
   * to `(USER MENTIONED YOU @AI_AGENT)` before the agent sees it, as the Node
   * bridge does; omit to leave messages as sent.
   */
  botUserId?: string;
  debounceMs?: number;
  /** `m.room.canonical_alias` of the room, when known. */
  canonicalAlias(roomId: string): string | null;
  dispatch(turn: IngestTurn): Promise<void>;
  onError?(err: unknown, context: string): void;
}

interface Pending {
  timer: ReturnType<typeof setTimeout>;
  messages: InboundMessage[];
  userDid: string;
}

export const DEFAULT_DEBOUNCE_MS = 500;
/** What the bot's own user id becomes in a message body (the Node bridge's wording). */
export const MENTIONED_BOT_MARKER = '(USER MENTIONED YOU @AI_AGENT)';

/** `did-ixo-ixo1abc` → `did:ixo:ixo1abc`. Only the first two dashes are separators. */
export function aliasPartToDid(part: string): string | null {
  const m = /^did-([a-z0-9]+)-(.+)$/.exec(part);
  if (!m) return null;
  return `did:${m[1]}:${m[2]}`;
}

/** Matrix user id → DID when the localpart is DID-shaped, else null. */
export function matrixUserIdToDid(userId: string): string | null {
  if (!userId.startsWith('@')) return null;
  const colon = userId.indexOf(':');
  const localpart = colon === -1 ? userId.slice(1) : userId.slice(1, colon);
  return aliasPartToDid(localpart);
}

/**
 * `#<userDidDashed>_<oracleDidDashed>:server` → user DID, or null when the
 * alias is not a user↔oracle room alias for THIS oracle.
 */
export function userDidFromRoomAlias(
  alias: string,
  oracleDid: string,
): string | null {
  if (!alias.startsWith('#')) return null;
  const colon = alias.indexOf(':');
  const local = colon === -1 ? alias.slice(1) : alias.slice(1, colon);
  const suffix = `_${didToAliasPart(oracleDid)}`;
  if (!local.endsWith(suffix)) return null;
  return aliasPartToDid(local.slice(0, -suffix.length));
}

/**
 * Who is the user for this message? The canonical alias names the room's
 * owner; the sender's localpart names the speaker. They agree in a 1:1
 * oracle room. When the speaker is DID-shaped but differs from the room
 * owner (a third member invited into the room), the SPEAKER wins — a turn
 * must never run inside another user's object. A non-DID sender in an
 * owner's room is attributed to the owner (legacy / non-DID accounts).
 */
export function resolveUserDid(opts: {
  alias: string | null;
  sender: string;
  oracleDid: string;
}): string | null {
  const fromSender = matrixUserIdToDid(opts.sender);
  const fromAlias = opts.alias
    ? userDidFromRoomAlias(opts.alias, opts.oracleDid)
    : null;
  if (fromSender && fromAlias && fromSender !== fromAlias) return fromSender;
  return fromAlias ?? fromSender;
}

/** The thread a message belongs to: its resolved root, else the message itself. */
export function threadRootIdOf(
  msg: Pick<InboundMessage, 'eventId' | 'threadRootId'>,
): string {
  return msg.threadRootId ?? msg.eventId;
}

export class IngestPipeline {
  private readonly pending = new Map<string, Pending>();
  private readonly debounceMs: number;

  constructor(private readonly deps: IngestDeps) {
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /**
   * Offer a decrypted message. Returns the reason it was dropped, or
   * `'queued'` when it entered the debounce buffer.
   */
  offer(msg: InboundMessage): 'queued' | 'empty' | 'unmapped' {
    if (!msg.body.trim() && !msg.attachment) return 'empty';
    const userDid = resolveUserDid({
      alias: this.deps.canonicalAlias(msg.roomId),
      sender: msg.sender,
      oracleDid: this.deps.oracleDid,
    });
    if (!userDid) return 'unmapped';

    const key = `${msg.roomId}|${threadRootIdOf(msg)}`;
    const existing = this.pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.messages.push(msg);
      existing.timer = setTimeout(() => void this.flush(key), this.debounceMs);
    } else {
      this.pending.set(key, {
        messages: [msg],
        userDid,
        timer: setTimeout(() => void this.flush(key), this.debounceMs),
      });
    }
    return 'queued';
  }

  /** Number of debounce buffers waiting to fire. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Cancel every buffer (shutdown). */
  clear(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  private async flush(key: string): Promise<void> {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    const first = entry.messages[0];
    if (!first) return;
    const threadId = threadRootIdOf(first);
    const texts = entry.messages.map((m) => m.body).filter((b) => b.trim());
    const source =
      [...entry.messages].reverse().find((m) => m.body.trim()) ?? first;
    const attachments = entry.messages.flatMap((m) =>
      m.attachment ? [m.attachment] : [],
    );
    // A file-only send still needs a user message the agent can act on —
    // the Node bridge's wording.
    const raw =
      texts.length > 0
        ? texts.join('\n')
        : attachments.length === 1
          ? `User shared a file: ${attachments[0]?.filename ?? 'file'}`
          : `User shared ${attachments.length} file(s): ${attachments.map((a) => a.filename).join(', ')}`;
    const message = this.deps.botUserId
      ? raw.replace(this.deps.botUserId, MENTIONED_BOT_MARKER)
      : raw;
    const turn: IngestTurn = {
      userDid: entry.userDid,
      matrixUserId: first.sender,
      roomId: first.roomId,
      threadId,
      sessionId: threadId,
      message,
      eventIds: entry.messages.map((m) => m.eventId),
      sourceEventId: source.eventId,
      ts: source.ts,
      mentionsBot: source.mentionsBot === true,
      ...(source.inReplyTo ? { inReplyTo: source.inReplyTo } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    };
    try {
      await this.deps.dispatch(turn);
    } catch (err) {
      this.deps.onError?.(err, `dispatch ${turn.sessionId}`);
    }
  }
}

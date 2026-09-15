/**
 * An end-to-end-encrypted Matrix client for a test user: a fresh device with
 * rust crypto, so the bot's encrypted replies can be read, and the few
 * primitives the room drills need — send a bare / threaded / quote-reply
 * message, wait for the bot's next message, read a thread.
 */
import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk';
import type { RoomMessageEventContent } from 'matrix-js-sdk/lib/@types/events';

export interface MatrixLogin {
  userId: string;
  accessToken: string;
  deviceId: string;
}

/** Password login against any homeserver (the harness helper is pinned to the harness URL). */
export async function loginWithPassword(
  baseUrl: string,
  userId: string,
  password: string,
): Promise<MatrixLogin> {
  const res = await fetch(`${baseUrl}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: userId },
      password,
      initial_device_display_name: 'qiforge e2e',
    }),
  });
  if (!res.ok)
    throw new Error(`login ${userId}: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    user_id: string;
    access_token: string;
    device_id: string;
  };
  return {
    userId: body.user_id,
    accessToken: body.access_token,
    deviceId: body.device_id,
  };
}

export interface BotMessageSeen {
  eventId: string;
  body: string;
  /** The `m.thread` root the bot posted under, if any. */
  threadRootId: string | undefined;
  relatesTo: unknown;
}

export interface E2eeClient {
  mx: MatrixClient;
  /** A bare text message in the main timeline; returns its event id. */
  send(roomId: string, body: string): Promise<string>;
  /** A text message inside the thread rooted at `rootId`. */
  sendInThread(roomId: string, rootId: string, body: string): Promise<string>;
  /** A quote-reply (`m.in_reply_to` only, no `m.thread`) — what a client without native threads sends. */
  quoteReply(roomId: string, targetId: string, body: string): Promise<string>;
  /** The bot's next `m.room.message` in the room after `since` whose body matches. */
  waitForBotMessage(
    roomId: string,
    botUserId: string,
    since: number,
    pattern: RegExp,
    timeoutMs?: number,
  ): Promise<BotMessageSeen>;
  /** Bodies of the bot's messages threaded under `rootId`, in timeline order. */
  threadBodies(
    roomId: string,
    botUserId: string,
    rootId: string,
  ): Promise<string[]>;
  stop(): void;
}

export async function createE2eeClient(
  baseUrl: string,
  login: MatrixLogin,
): Promise<E2eeClient> {
  const sdk = await import('matrix-js-sdk');
  const mx = sdk.createClient({
    baseUrl,
    accessToken: login.accessToken,
    userId: login.userId,
    deviceId: login.deviceId,
    store: new sdk.MemoryStore(),
    useAuthorizationHeader: true,
  });
  await mx.initRustCrypto({ useIndexedDB: false });
  await mx.startClient({ initialSyncLimit: 5, lazyLoadMembers: true });
  await new Promise<void>((resolve) => {
    const onSync = (state: string) => {
      if (state === 'PREPARED' || state === 'SYNCING') {
        mx.removeListener(sdk.ClientEvent.Sync, onSync);
        resolve();
      }
    };
    mx.on(sdk.ClientEvent.Sync, onSync);
  });

  // `sendMessage` with a thread id adds the `m.thread` relation (plus the
  // `is_falling_back` reply pointer) exactly as a threading client does.
  const sendContent = async (
    roomId: string,
    threadId: string | null,
    content: RoomMessageEventContent,
  ): Promise<string> => {
    const res = await mx.sendMessage(roomId, threadId, content);
    return res.event_id;
  };

  const seen = async (event: MatrixEvent): Promise<BotMessageSeen> => {
    await mx.decryptEventIfNeeded(event);
    const content = event.getContent() as {
      body?: string;
      'm.relates_to'?: unknown;
    };
    return {
      eventId: event.getId() ?? '',
      body: String(content.body ?? ''),
      threadRootId: event.threadRootId,
      relatesTo: content['m.relates_to'],
    };
  };

  return {
    mx,
    send: (roomId, body) =>
      sendContent(roomId, null, { msgtype: sdk.MsgType.Text, body }),
    sendInThread: (roomId, rootId, body) =>
      sendContent(roomId, rootId, { msgtype: sdk.MsgType.Text, body }),
    quoteReply: (roomId, targetId, body) =>
      sendContent(roomId, null, {
        msgtype: sdk.MsgType.Text,
        body,
        'm.relates_to': { 'm.in_reply_to': { event_id: targetId } },
      }),
    waitForBotMessage: (
      roomId,
      botUserId,
      since,
      pattern,
      timeoutMs = 120_000,
    ) =>
      new Promise<BotMessageSeen>((resolve, reject) => {
        const timer = setTimeout(() => {
          mx.removeListener(sdk.RoomEvent.Timeline, onTimeline);
          reject(
            new Error(
              `no bot message matching ${pattern} within ${timeoutMs} ms`,
            ),
          );
        }, timeoutMs);
        const onTimeline = (event: MatrixEvent): void => {
          if (event.getRoomId() !== roomId || event.getSender() !== botUserId)
            return;
          if (event.getTs() < since) return;
          void (async () => {
            await mx.decryptEventIfNeeded(event);
            if (event.getType() !== 'm.room.message') return;
            const message = await seen(event);
            if (!pattern.test(message.body)) return;
            clearTimeout(timer);
            mx.removeListener(sdk.RoomEvent.Timeline, onTimeline);
            resolve(message);
          })();
        };
        mx.on(sdk.RoomEvent.Timeline, onTimeline);
      }),
    threadBodies: async (roomId, botUserId, rootId) => {
      const room = mx.getRoom(roomId);
      const bodies: string[] = [];
      for (const e of room?.getLiveTimeline().getEvents() ?? []) {
        if (e.getSender() !== botUserId) continue;
        const message = await seen(e);
        if (message.threadRootId !== rootId) continue;
        bodies.push(message.body);
      }
      return bodies;
    },
    stop: () => mx.stopClient(),
  };
}

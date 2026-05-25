import { type SessionManagerService } from '@ixo/common';
import { type MessageEvent, type MessageEventContent } from '@ixo/matrix';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '../../testing/nest-doubles.js';
import {
  MatrixListenerBridge,
  type MatrixIncomingMessage,
} from './matrix-listener-bridge.js';
import { makeSessionManagerStub } from './__test-fixtures__/deps.js';

const ORACLE_DID = 'did:ixo:oracle';
const ORACLE_ENTITY_DID = 'did:ixo:oracle-entity';
const ORACLE_NAME = 'TestOracle';
const ORACLE_SENDER = '@did-ixo-oracle:home.server';
const USER_SENDER = '@did-ixo-user-1:home.server';
const USER_DID = 'did:ixo:user-1';
const ROOM_ID = '!room:home.server';

type RawEvent = {
  event_id: string;
  sender: string;
  type: string;
  content: Record<string, unknown>;
  origin_server_ts?: number;
};

function makeEvent(
  overrides: Partial<RawEvent> = {},
): MessageEvent<MessageEventContent> {
  const base: RawEvent = {
    event_id: 'evt-1',
    sender: USER_SENDER,
    type: 'm.room.message',
    content: { msgtype: 'm.text', body: 'hello' },
    origin_server_ts: 0,
    ...overrides,
  };
  // Structural double — the bridge only reads .eventId, .sender, .content;
  // we shape the raw fields the matrix-bot-sdk getters return.
  return {
    eventId: base.event_id,
    sender: base.sender,
    type: base.type,
    content: base.content,
  } as unknown as MessageEvent<MessageEventContent>;
}

interface Harness {
  bridge: MatrixListenerBridge;
  sessions: ReturnType<typeof makeSessionManagerStub>;
  onMessageCallback: (
    roomId: string,
    event: MessageEvent<MessageEventContent>,
  ) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
}

async function build(): Promise<Harness> {
  const sessions = makeSessionManagerStub();
  let onMessageCallback:
    | ((roomId: string, event: MessageEvent<MessageEventContent>) => void)
    | undefined;
  const unsubscribe = vi.fn();
  sessions.matrixManger.onMessage.mockImplementation(
    (
      cb: (roomId: string, event: MessageEvent<MessageEventContent>) => void,
    ) => {
      onMessageCallback = cb;
      return unsubscribe;
    },
  );

  const config = makeConfig({
    ORACLE_DID,
    ORACLE_ENTITY_DID,
    ORACLE_NAME,
  });

  const bridge = new MatrixListenerBridge(
    sessions as unknown as SessionManagerService,
    config,
  );
  bridge.onModuleInit();
  // onModuleInit awaits matrixManager.init() in a .then() — drain microtasks.
  await Promise.resolve();
  await Promise.resolve();

  if (!onMessageCallback) {
    throw new Error('onMessage callback was not registered');
  }
  return { bridge, sessions, onMessageCallback, unsubscribe };
}

async function deliver(
  h: Harness,
  event: MessageEvent<MessageEventContent>,
  roomId = ROOM_ID,
): Promise<void> {
  h.onMessageCallback(roomId, event);
  // Drain the .catch() chain inside the registered callback so awaited work
  // (ensureSession, getThreadRoot) finishes before assertions.
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
}

describe('MatrixListenerBridge', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('filtering', () => {
    it("ignores oracle's own messages (sender == ORACLE_DID)", async () => {
      const h = await build();
      const deliverHandler = vi.fn().mockResolvedValue(undefined);
      h.bridge.setDeliverHandler(deliverHandler);

      await deliver(
        h,
        makeEvent({
          event_id: 'evt-oracle',
          sender: ORACLE_SENDER,
          content: { msgtype: 'm.text', body: 'hi from oracle' },
        }),
      );

      expect(h.sessions.matrixManger.getEventById).not.toHaveBeenCalled();
      expect(deliverHandler).not.toHaveBeenCalled();
    });

    it("ignores events with 'INTERNAL' in content", async () => {
      const h = await build();
      const deliverHandler = vi.fn().mockResolvedValue(undefined);
      h.bridge.setDeliverHandler(deliverHandler);

      await deliver(
        h,
        makeEvent({
          event_id: 'evt-internal',
          content: { msgtype: 'm.text', body: 'x', INTERNAL: true },
        }),
      );

      expect(h.sessions.matrixManger.getEventById).not.toHaveBeenCalled();
      expect(deliverHandler).not.toHaveBeenCalled();
    });

    it('ignores msgtypes outside m.text + file types', async () => {
      const h = await build();
      const deliverHandler = vi.fn().mockResolvedValue(undefined);
      h.bridge.setDeliverHandler(deliverHandler);

      await deliver(
        h,
        makeEvent({
          event_id: 'evt-notice',
          content: { msgtype: 'm.notice', body: 'noticed' },
        }),
      );
      await deliver(
        h,
        makeEvent({
          event_id: 'evt-loc',
          content: { msgtype: 'm.location', body: 'where' },
        }),
      );

      expect(h.sessions.matrixManger.getEventById).not.toHaveBeenCalled();
      expect(deliverHandler).not.toHaveBeenCalled();
    });
  });

  describe('thread root resolution', () => {
    it("returns event's own id when no m.in_reply_to", async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const h = await build();
        const deliverHandler = vi.fn().mockResolvedValue({
          message: { content: 'ai reply' },
        });
        h.bridge.setDeliverHandler(deliverHandler);

        h.sessions.matrixManger.getEventById.mockResolvedValue({
          content: { sessionId: 'lc-thread-1' },
        });
        h.sessions.getSession.mockResolvedValue({ sessionId: 'evt-root' });

        await deliver(
          h,
          makeEvent({
            event_id: 'evt-root',
            content: { msgtype: 'm.text', body: 'first' },
          }),
        );

        await vi.advanceTimersByTimeAsync(500);
        for (let i = 0; i < 6; i += 1) await Promise.resolve();

        expect(deliverHandler).toHaveBeenCalledWith(
          expect.objectContaining({ threadId: 'evt-root' }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('walks the reply chain to the root and caches every visited id', async () => {
      const h = await build();
      // Chain: leaf -> mid -> root (no m.in_reply_to on root).
      h.sessions.matrixManger.getEventById.mockImplementation(
        async (_roomId: string, id: string) => {
          if (id === 'mid') {
            return {
              content: {
                'm.relates_to': { 'm.in_reply_to': { event_id: 'root' } },
              },
            };
          }
          if (id === 'root') {
            return { content: { sessionId: 'lc-thread-root' } };
          }
          throw new Error(`unexpected id ${id}`);
        },
      );
      h.sessions.getSession.mockResolvedValue({ sessionId: 'root' });
      const deliverHandler = vi.fn().mockResolvedValue(undefined);
      h.bridge.setDeliverHandler(deliverHandler);

      await deliver(
        h,
        makeEvent({
          event_id: 'leaf',
          content: {
            msgtype: 'm.text',
            body: 'leaf',
            'm.relates_to': { 'm.in_reply_to': { event_id: 'mid' } },
          },
        }),
      );

      // Walking chain is sync via Promises — let it settle past two awaits.
      for (let i = 0; i < 10; i += 1) await Promise.resolve();

      const calls = h.sessions.matrixManger.getEventById.mock.calls.map(
        (c) => c[1],
      );
      expect(calls).toContain('mid');
      expect(calls).toContain('root');

      // Second event whose reply chain hits a cached id should NOT re-walk.
      h.sessions.matrixManger.getEventById.mockClear();
      // After the first call resolves, root reads root again to derive
      // langchainThreadId via getEventById(threadId), not a chain walk.
      h.sessions.matrixManger.getEventById.mockResolvedValue({
        content: { sessionId: 'lc-thread-root' },
      });

      await deliver(
        h,
        makeEvent({
          event_id: 'leaf-2',
          content: {
            msgtype: 'm.text',
            body: 'leaf-2',
            'm.relates_to': { 'm.in_reply_to': { event_id: 'mid' } },
          },
        }),
      );
      for (let i = 0; i < 10; i += 1) await Promise.resolve();

      const secondCalls = h.sessions.matrixManger.getEventById.mock.calls.map(
        (c) => c[1],
      );
      // mid already cached -> root resolved via cache; only the
      // post-resolution getEventById(threadId='root') for langchainThreadId.
      expect(secondCalls).not.toContain('mid');
    });

    it('cycle in reply chain breaks out via visited set', async () => {
      const h = await build();
      // Cycle: a -> b -> a -> ...
      h.sessions.matrixManger.getEventById.mockImplementation(
        async (_roomId: string, id: string) => {
          if (id === 'a') {
            return {
              content: {
                'm.relates_to': { 'm.in_reply_to': { event_id: 'b' } },
              },
            };
          }
          if (id === 'b') {
            return {
              content: {
                'm.relates_to': { 'm.in_reply_to': { event_id: 'a' } },
              },
            };
          }
          return { content: { sessionId: 'lc-fallback' } };
        },
      );
      h.sessions.getSession.mockResolvedValue({ sessionId: 'leaf' });
      const deliverHandler = vi.fn().mockResolvedValue(undefined);
      h.bridge.setDeliverHandler(deliverHandler);

      const startTime = Date.now();
      await deliver(
        h,
        makeEvent({
          event_id: 'leaf',
          content: {
            msgtype: 'm.text',
            body: 'cycle leaf',
            'm.relates_to': { 'm.in_reply_to': { event_id: 'a' } },
          },
        }),
      );
      for (let i = 0; i < 20; i += 1) await Promise.resolve();

      // Must terminate (no infinite loop). Cycle visited set bails out.
      expect(Date.now() - startTime).toBeLessThan(2000);
      // Each cycle node visited at most once during the walk.
      const walkCalls = h.sessions.matrixManger.getEventById.mock.calls.filter(
        ([, id]) => id === 'a' || id === 'b',
      );
      // 'a' read once (initial inReplyTo lookup), 'b' read once (parent),
      // 'a' would short-circuit via visited Set. Total walk calls: 2.
      expect(walkCalls.length).toBeLessThanOrEqual(3);
    });

    it('getEventById errors propagate (caught at caller)', async () => {
      const h = await build();
      h.sessions.matrixManger.getEventById.mockRejectedValue(
        new Error('matrix unreachable'),
      );
      const deliverHandler = vi.fn().mockResolvedValue(undefined);
      h.bridge.setDeliverHandler(deliverHandler);

      await deliver(
        h,
        makeEvent({
          event_id: 'leaf-err',
          content: {
            msgtype: 'm.text',
            body: 'err',
            'm.relates_to': { 'm.in_reply_to': { event_id: 'unknown' } },
          },
        }),
      );
      for (let i = 0; i < 10; i += 1) await Promise.resolve();

      // Caller catches in onModuleInit's `.catch(...)`; deliverHandler never
      // runs and we don't crash the process.
      expect(deliverHandler).not.toHaveBeenCalled();
    });
  });

  describe('debouncing', () => {
    it('first event sets a 500ms timer, second within window resets it', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const h = await build();
        h.sessions.matrixManger.getEventById.mockResolvedValue({
          content: { sessionId: 'lc-thread' },
        });
        h.sessions.getSession.mockResolvedValue({ sessionId: 'root' });
        const deliverHandler = vi.fn().mockResolvedValue(undefined);
        h.bridge.setDeliverHandler(deliverHandler);

        await deliver(
          h,
          makeEvent({
            event_id: 'root',
            content: { msgtype: 'm.text', body: 'first' },
          }),
        );

        await vi.advanceTimersByTimeAsync(400);
        expect(deliverHandler).not.toHaveBeenCalled();

        // Second event in same thread within window -> timer reset.
        await deliver(
          h,
          makeEvent({
            event_id: 'root2',
            content: {
              msgtype: 'm.text',
              body: 'second',
              'm.relates_to': { 'm.in_reply_to': { event_id: 'root' } },
            },
          }),
        );

        // 400ms after the second event would have been 800ms after the
        // first; if timer hadn't reset, deliver would already fire.
        await vi.advanceTimersByTimeAsync(400);
        expect(deliverHandler).not.toHaveBeenCalled();

        // Now cross 500ms past the second event.
        await vi.advanceTimersByTimeAsync(150);
        for (let i = 0; i < 6; i += 1) await Promise.resolve();
        expect(deliverHandler).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('flush merges text + attachments into one MatrixIncomingMessage', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const h = await build();
        h.sessions.matrixManger.getEventById.mockResolvedValue({
          content: { sessionId: 'lc-thread' },
        });
        h.sessions.getSession.mockResolvedValue({ sessionId: 'root' });
        const deliverHandler = vi.fn().mockResolvedValue({
          message: { content: 'ai reply' },
        });
        h.bridge.setDeliverHandler(deliverHandler);

        await deliver(
          h,
          makeEvent({
            event_id: 'root',
            content: { msgtype: 'm.text', body: 'caption' },
          }),
        );
        await deliver(
          h,
          makeEvent({
            event_id: 'file-evt',
            content: {
              msgtype: 'm.image',
              body: 'photo.png',
              filename: 'photo.png',
              info: { mimetype: 'image/png', size: 1234 },
              'm.relates_to': { 'm.in_reply_to': { event_id: 'root' } },
            },
          }),
        );

        await vi.advanceTimersByTimeAsync(500);
        for (let i = 0; i < 6; i += 1) await Promise.resolve();

        expect(deliverHandler).toHaveBeenCalledTimes(1);
        const payload = deliverHandler.mock
          .calls[0]?.[0] as MatrixIncomingMessage;
        expect(payload.message).toBe('caption');
        expect(payload.attachments).toEqual([
          {
            eventId: 'file-evt',
            filename: 'photo.png',
            mimetype: 'image/png',
            size: 1234,
          },
        ]);
        expect(payload.threadId).toBe('root');
        expect(payload.did).toBe(USER_DID);
      } finally {
        vi.useRealTimers();
      }
    });

    it("flush builds 'User shared a file' synthetic message when text absent", async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const h = await build();
        h.sessions.matrixManger.getEventById.mockResolvedValue({
          content: { sessionId: 'lc-thread' },
        });
        h.sessions.getSession.mockResolvedValue({ sessionId: 'file-only' });
        const deliverHandler = vi.fn().mockResolvedValue({
          message: { content: 'ai reply' },
        });
        h.bridge.setDeliverHandler(deliverHandler);

        await deliver(
          h,
          makeEvent({
            event_id: 'file-only',
            content: {
              msgtype: 'm.file',
              body: 'doc.pdf',
              filename: 'doc.pdf',
              info: { mimetype: 'application/pdf', size: 9 },
            },
          }),
        );

        await vi.advanceTimersByTimeAsync(500);
        for (let i = 0; i < 6; i += 1) await Promise.resolve();

        const payload = deliverHandler.mock
          .calls[0]?.[0] as MatrixIncomingMessage;
        expect(payload.message).toBe('User shared a file: doc.pdf');
        expect(payload.attachments).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('flush drops the buffer entry before calling deliverHandler', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const h = await build();
        h.sessions.matrixManger.getEventById.mockResolvedValue({
          content: { sessionId: 'lc-thread' },
        });
        h.sessions.getSession.mockResolvedValue({ sessionId: 'root' });

        let bufferedEventIdsDuringDeliver: string[] | undefined;
        const deliverHandler = vi.fn(async () => {
          // Re-enter while deliverHandler runs: a new event on the SAME
          // thread should land in a FRESH buffer entry (the prior entry
          // must have been deleted before deliverHandler ran).
          await deliver(
            h,
            makeEvent({
              event_id: 'reentry-evt',
              content: {
                msgtype: 'm.text',
                body: 'reentry',
                'm.relates_to': { 'm.in_reply_to': { event_id: 'root' } },
              },
            }),
          );
          // Reach into the private buffer to verify a fresh entry exists
          // with only the re-entry event, not the original.
          const buffer = (
            h.bridge as unknown as {
              buffer: Map<string, { events: { event: { eventId: string } }[] }>;
            }
          ).buffer;
          const entry = buffer.get('root');
          bufferedEventIdsDuringDeliver = entry
            ? entry.events.map((e) => e.event.eventId)
            : undefined;
          return { message: { content: 'ack' } };
        });
        h.bridge.setDeliverHandler(deliverHandler);

        await deliver(
          h,
          makeEvent({
            event_id: 'root',
            content: { msgtype: 'm.text', body: 'first' },
          }),
        );

        await vi.advanceTimersByTimeAsync(500);
        for (let i = 0; i < 10; i += 1) await Promise.resolve();

        expect(deliverHandler).toHaveBeenCalled();
        expect(bufferedEventIdsDuringDeliver).toEqual(['reentry-evt']);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('deliverHandler missing', () => {
    it('flush logs warn and drops the message when setDeliverHandler never called', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const h = await build();
        h.sessions.matrixManger.getEventById.mockResolvedValue({
          content: { sessionId: 'lc-thread' },
        });
        h.sessions.getSession.mockResolvedValue({ sessionId: 'root' });
        // Spy on the logger so we can prove the warn fires.
        const warnSpy = vi
          .spyOn(
            (h.bridge as unknown as { logger: { warn: (m: string) => void } })
              .logger,
            'warn',
          )
          .mockImplementation(() => undefined);

        await deliver(
          h,
          makeEvent({
            event_id: 'root',
            content: { msgtype: 'm.text', body: 'no handler' },
          }),
        );
        await vi.advanceTimersByTimeAsync(500);
        for (let i = 0; i < 6; i += 1) await Promise.resolve();

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('deliverHandler not set'),
        );
        // matrixManger.sendMessage MUST NOT be called when handler missing.
        expect(h.sessions.matrixManger.sendMessage).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('ensureSession', () => {
    it('createSession called when sessions.getSession returns undefined', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const h = await build();
        h.sessions.matrixManger.getEventById.mockResolvedValue({
          content: { sessionId: 'lc-thread' },
        });
        h.sessions.getSession.mockResolvedValue(undefined);
        h.sessions.createSession.mockResolvedValue({ sessionId: 'root' });
        const deliverHandler = vi.fn().mockResolvedValue({
          message: { content: 'ai reply' },
        });
        h.bridge.setDeliverHandler(deliverHandler);

        await deliver(
          h,
          makeEvent({
            event_id: 'root',
            content: { msgtype: 'm.text', body: 'new user' },
          }),
        );
        await vi.advanceTimersByTimeAsync(500);
        for (let i = 0; i < 6; i += 1) await Promise.resolve();

        expect(h.sessions.createSession).toHaveBeenCalledWith(
          expect.objectContaining({
            did: USER_DID,
            oracleDid: ORACLE_DID,
            oracleEntityDid: ORACLE_ENTITY_DID,
            oracleName: ORACLE_NAME,
            homeServer: 'home.server',
            roomId: ROOM_ID,
          }),
          'root',
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('createSession NOT called when session exists', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const h = await build();
        h.sessions.matrixManger.getEventById.mockResolvedValue({
          content: { sessionId: 'lc-thread' },
        });
        h.sessions.getSession.mockResolvedValue({ sessionId: 'root' });
        const deliverHandler = vi.fn().mockResolvedValue({
          message: { content: 'ai reply' },
        });
        h.bridge.setDeliverHandler(deliverHandler);

        await deliver(
          h,
          makeEvent({
            event_id: 'root',
            content: { msgtype: 'm.text', body: 'existing user' },
          }),
        );
        await vi.advanceTimersByTimeAsync(500);
        for (let i = 0; i < 6; i += 1) await Promise.resolve();

        expect(h.sessions.createSession).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('normalizeDid', () => {
    it('throws on input missing @did-<ns>-<id>:server shape', async () => {
      const h = await build();
      const deliverHandler = vi.fn().mockResolvedValue(undefined);
      h.bridge.setDeliverHandler(deliverHandler);
      // normalizeDid is called inside handleMessage; a malformed sender
      // makes the catch in the registered listener's .catch(...) swallow
      // the throw. We verify the throw happened by asserting no downstream
      // work ran.
      await deliver(
        h,
        makeEvent({
          event_id: 'evt-bad',
          sender: '@not-a-did:home.server',
          content: { msgtype: 'm.text', body: 'malformed' },
        }),
      );

      expect(h.sessions.matrixManger.getEventById).not.toHaveBeenCalled();
      expect(deliverHandler).not.toHaveBeenCalled();
    });

    it("parses 'did:ixo:abc' from '@did-ixo-abc:home.server'", async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const h = await build();
        h.sessions.matrixManger.getEventById.mockResolvedValue({
          content: { sessionId: 'lc-thread' },
        });
        h.sessions.getSession.mockResolvedValue({ sessionId: 'root' });
        const deliverHandler = vi.fn().mockResolvedValue({
          message: { content: 'reply' },
        });
        h.bridge.setDeliverHandler(deliverHandler);

        await deliver(
          h,
          makeEvent({
            event_id: 'root',
            sender: '@did-ixo-abc:home.server',
            content: { msgtype: 'm.text', body: 'hi' },
          }),
        );
        await vi.advanceTimersByTimeAsync(500);
        for (let i = 0; i < 6; i += 1) await Promise.resolve();

        const payload = deliverHandler.mock
          .calls[0]?.[0] as MatrixIncomingMessage;
        expect(payload.did).toBe('did:ixo:abc');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('onModuleDestroy', () => {
    it('clears every pending buffer timer and unsubscribes the listener', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const h = await build();
        h.sessions.matrixManger.getEventById.mockResolvedValue({
          content: { sessionId: 'lc-thread' },
        });
        h.sessions.getSession.mockResolvedValue({ sessionId: 'root' });
        const deliverHandler = vi.fn().mockResolvedValue(undefined);
        h.bridge.setDeliverHandler(deliverHandler);

        await deliver(
          h,
          makeEvent({
            event_id: 'root',
            content: { msgtype: 'm.text', body: 'buffered' },
          }),
        );

        h.bridge.onModuleDestroy();

        // Buffer must be empty after destroy; advancing past the debounce
        // window must NOT fire deliverHandler (timer was cleared).
        await vi.advanceTimersByTimeAsync(1000);
        for (let i = 0; i < 6; i += 1) await Promise.resolve();

        expect(deliverHandler).not.toHaveBeenCalled();
        expect(h.unsubscribe).toHaveBeenCalledTimes(1);
        const buffer = (
          h.bridge as unknown as {
            buffer: Map<string, unknown>;
          }
        ).buffer;
        expect(buffer.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

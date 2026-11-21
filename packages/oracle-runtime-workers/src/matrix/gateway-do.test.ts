/**
 * `MatrixGatewayDO` on real Durable Object storage (the SQLite test object's
 * state), with the homeserver and the user objects scripted: who a room
 * message is attributed to (the sender DID, never the room alias), what
 * happens when the homeserver fails while a message is prepared, the inbox
 * replay caps, the in-memory memos, the cheap status/health surface and the
 * media event lookup with its deadline.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import {
  MatrixBotDO,
  shouldRecycle,
  withDefaults,
  type BotMessage,
  type MatrixBotOptions,
  type SendTextOpts,
} from '@ixo/matrix-bot-workers-sdk';
import { MatrixError } from 'matrix-js-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqliteTestDO } from '../sqlite/test-do';
import type { JsonString, OracleWorkerEnv, TurnResult } from '../do/contracts';
import {
  BACKGROUND_SEND_CONCURRENCY,
  DEFAULT_RECYCLE_AFTER_SENDS,
  MatrixGatewayDO,
} from './gateway-do';
import { GroupChatService, type GateDecision } from './group-chat';
import type { TurnRefusal } from '../plugin-api/turn-gate';
import { insertInboxRow, listInboxRows, MAX_TURN_REPLAYS } from './inbox-store';
import type { IngestTurn } from './ingest';
import { MediaDownloadTimeoutError } from './media-deadline';

const ORACLE_DID = 'did:ixo:ixo1oracle';
const BOT = '@did-ixo-ixo1oracle:ixo.test';
const VICTIM_DID = 'did:ixo:ixo1victim';
/** The victim's user↔oracle alias, on the victim's (and the oracle's) server. */
const VICTIM_ALIAS = '#did-ixo-ixo1victim_did-ixo-ixo1oracle:ixo.test';
const ROOM = '!room:ixo.test';

const unused = (): never => {
  throw new Error('not used by this test');
};
const noNamespace = {
  newUniqueId: unused,
  idFromName: unused,
  idFromString: unused,
  get: unused,
  getByName: unused,
  getExisting: unused,
  jurisdiction: unused,
};

function gatewayEnv(extra: Partial<OracleWorkerEnv> = {}): OracleWorkerEnv {
  return {
    USER_ORACLE: noNamespace,
    MATRIX_GATEWAY: noNamespace,
    ORACLE_NAME: 'test',
    ORACLE_DID,
    // No Blocksync: every DID is registered on the oracle's own server.
    BLOCKSYNC_GRAPHQL_URL: '',
    MATRIX_BASE_URL: 'https://ixo.test',
    MATRIX_ORACLE_ADMIN_USER_ID: BOT,
    MATRIX_ORACLE_ADMIN_PASSWORD: 'pw',
    OPEN_ROUTER_API_KEY: 'k',
    LOG_LEVEL: 'silent',
    ...extra,
  };
}

interface Homeserver {
  /** Canonical alias state per room (absent = none). */
  aliasState: Map<string, string>;
  /** Alias directory: alias → room. */
  directory: Map<string, string>;
  /** Thrown by the next N `resolveAlias` calls. */
  resolveFailures: number;
  /** Thrown by the next N `getRoomStateEvent` calls. */
  stateFailures: number;
  typingFails: boolean;
  members: string[];
}

/** The gateway with its homeserver and user objects replaced by scripts. */
class TestGateway extends MatrixGatewayDO {
  protected override readonly senderCheckRetryMs = SENDER_CHECK_RETRY_MS;
  readonly hs: Homeserver = {
    aliasState: new Map(),
    directory: new Map(),
    resolveFailures: 0,
    stateFailures: 0,
    typingFails: false,
    members: [BOT, '@someone:ixo.test'],
  };
  readonly turns: IngestTurn[] = [];
  readonly sent: Array<{
    kind: 'text' | 'notice';
    roomId: string;
    body: string;
  }> = [];
  resolveCalls = 0;
  /** Runs before each `resolveAlias` answers (replace to hold or interleave it). */
  beforeResolve: () => Promise<void> = async () => undefined;
  /** Event ids `getEvent` was asked for, in order. */
  readonly eventReads: string[] = [];
  /** Runs before each `getEvent` answers (replace to hold it). */
  beforeEventRead: () => Promise<void> = async () => undefined;
  /** Decrypted events `getEvent` answers with, by id. */
  readonly events = new Map<string, unknown>();
  /** Whether the gateway sees the room as end-to-end encrypted. */
  roomEncrypted = true;
  /** Resolves a turn; replace to hold one open. */
  turnResult: () => Promise<TurnResult> = async () => ({
    sessionId: 's',
    requestId: 'r',
    text: 'reply',
    toolCalls: [],
  });
  mediaOpen: () => Promise<{ stream: ReadableStream<Uint8Array> } | null> =
    async () => null;

  deliver(message: BotMessage): Promise<void> {
    return this.onMessage(message);
  }

  botOptions(): Promise<MatrixBotOptions> {
    return this.resolveOptions();
  }

  restartReplay(): Promise<void> {
    return this.onStarted({ started: true, userId: BOT, deviceId: 'D' });
  }

  aliasEvent(roomId: string): Promise<void> {
    return this.onEvent({
      eventId: '$alias',
      roomId,
      type: 'm.room.canonical_alias',
      sender: '@admin:ixo.test',
      ts: Date.now(),
      content: {},
      encrypted: false,
    });
  }

  override async getRoomStateEvent(
    roomId: string,
    type: string,
  ): Promise<JsonString | null> {
    if (this.hs.stateFailures > 0) {
      this.hs.stateFailures -= 1;
      throw new Error('M_LIMIT_EXCEEDED');
    }
    if (type !== 'm.room.canonical_alias') return null;
    const alias = this.hs.aliasState.get(roomId);
    return alias ? JSON.stringify({ alias }) : null;
  }

  override async resolveAlias(alias: string): Promise<string | null> {
    this.resolveCalls += 1;
    await this.beforeResolve();
    if (this.hs.resolveFailures > 0) {
      this.hs.resolveFailures -= 1;
      throw new Error('502 Bad Gateway');
    }
    return this.hs.directory.get(alias) ?? null;
  }

  override async setTyping(): Promise<void> {
    if (this.hs.typingFails) throw new Error('M_UNKNOWN typing');
  }

  override async sendText(roomId: string, body: string): Promise<string> {
    this.sent.push({ kind: 'text', roomId, body });
    return '$reply';
  }

  /** Every notice with the options it was sent with. */
  readonly notices: Array<{
    roomId: string;
    body: string;
    opts: SendTextOpts | undefined;
  }> = [];

  override async sendNotice(
    roomId: string,
    body: string,
    opts?: SendTextOpts,
  ): Promise<string> {
    this.sent.push({ kind: 'notice', roomId, body });
    this.notices.push({ roomId, body, opts });
    return '$notice';
  }

  override async getEvent(
    _roomId: string,
    eventId: string,
  ): Promise<JsonString | null> {
    this.eventReads.push(eventId);
    await this.beforeEventRead();
    const event = this.events.get(eventId);
    return event === undefined ? null : JSON.stringify(event);
  }

  override async isRoomEncrypted(): Promise<boolean> {
    return this.roomEncrypted;
  }

  override async getJoinedRoomMembers(): Promise<string[]> {
    return this.hs.members;
  }

  override async getUserProfile(): Promise<{ displayname?: string } | null> {
    return null;
  }

  override async downloadFileStream(): Promise<{
    stream: ReadableStream<Uint8Array>;
  } | null> {
    return this.mediaOpen();
  }

  protected override async runTurn(
    turn: IngestTurn,
    _requestId: string,
    _decision: GateDecision,
  ): Promise<TurnResult> {
    this.turns.push(turn);
    return this.turnResult();
  }

  protected override async finishWorkStatus(): Promise<void> {
    // The work-status card lives in the user object.
  }
}

let seq = 0;
function message(sender: string, over: Partial<BotMessage> = {}): BotMessage {
  seq += 1;
  return {
    roomId: ROOM,
    sender,
    ts: Date.now(),
    body: `hello ${seq}`,
    msgtype: 'm.text',
    eventIds: [`$m${seq}`],
    content: { msgtype: 'm.text', body: `hello ${seq}` },
    ...over,
  };
}

/** Run `fn` against a fresh gateway on fresh SQLite storage. */
async function withGateway(
  name: string,
  fn: (gw: TestGateway, state: DurableObjectState) => Promise<void>,
  extra: Partial<OracleWorkerEnv> = {},
): Promise<void> {
  const stub = env.SQLITE_TEST.get(env.SQLITE_TEST.idFromName(name));
  await runInDurableObject(stub, async (_i: SqliteTestDO, state) => {
    const gw = new TestGateway(state, gatewayEnv(extra));
    try {
      await fn(gw, state);
    } finally {
      await gw.stop().catch(() => undefined);
    }
  });
}

const DEBOUNCE_MS = 500;

const USER = '@did-ixo-ixo1user:ixo.test';
const OUT_OF_CREDITS: TurnRefusal = {
  status: 402,
  code: 'insufficient_credits',
  message: "You're out of IXO credits. Top up to keep chatting.",
  details: {
    action: { label: 'Top up credits', url: 'https://portal.example/credits' },
  },
};

function refusedResult(refused: TurnRefusal): TurnResult {
  return { sessionId: 's', requestId: 'r', text: '', toolCalls: [], refused };
}
/** The retry delay, shortened for the test (production: 60 s). */
const SENDER_CHECK_RETRY_MS = 300;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sender attribution and room alias verification', () => {
  it("a sender on a foreign server in a room claiming the victim's alias (resolving elsewhere) is unmapped and wakes no user object", async () => {
    await withGateway('gw-alias-elsewhere', async (gw, state) => {
      gw.hs.aliasState.set(ROOM, VICTIM_ALIAS);
      // The real alias points at the victim's real room.
      gw.hs.directory.set(VICTIM_ALIAS, '!victims-real-room:ixo.test');
      await gw.deliver(message('@mallory:evil.example'));
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
      expect(gw.turns).toEqual([]);
      expect(gw.sent).toEqual([]);
      expect(listInboxRows(state.storage.sql)).toEqual([]);
    });
  });

  it("… also when the alias resolves nowhere (404), and also for a sender on the alias's own server", async () => {
    await withGateway('gw-alias-404', async (gw, state) => {
      gw.hs.aliasState.set(ROOM, VICTIM_ALIAS);
      await gw.deliver(message('@mallory:evil.example'));
      await gw.deliver(message('@legacy:ixo.test'));
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
      expect(gw.turns).toEqual([]);
      expect(listInboxRows(state.storage.sql)).toEqual([]);
    });
  });

  it('a sender on a foreign server stays unmapped even when the alias is genuine', async () => {
    await withGateway('gw-alias-genuine-foreign', async (gw) => {
      gw.hs.aliasState.set(ROOM, VICTIM_ALIAS);
      gw.hs.directory.set(VICTIM_ALIAS, ROOM);
      await gw.deliver(message('@mallory:evil.example'));
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
      expect(gw.turns).toEqual([]);
    });
  });

  it("a non-DID sender on the alias's own server never gets the room owner's turn", async () => {
    await withGateway('gw-alias-legit', async (gw, state) => {
      gw.hs.aliasState.set(ROOM, VICTIM_ALIAS);
      gw.hs.directory.set(VICTIM_ALIAS, ROOM);
      await gw.deliver(message('@legacy:ixo.test'));
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
      expect(gw.turns).toEqual([]);
      expect(gw.sent).toEqual([]);
      expect(listInboxRows(state.storage.sql)).toEqual([]);
    });
  });

  it("memoises the verdict per room and asks again after the room's alias state changes", async () => {
    await withGateway('gw-alias-memo', async (gw) => {
      gw.hs.aliasState.set(ROOM, VICTIM_ALIAS);
      gw.hs.directory.set(VICTIM_ALIAS, ROOM);
      await gw.deliver(message('@did-ixo-ixo1victim:ixo.test'));
      await gw.deliver(message('@did-ixo-ixo1victim:ixo.test'));
      expect(gw.resolveCalls).toBe(1);
      // The alias is re-pointed elsewhere and the room's alias event arrives.
      gw.hs.directory.set(VICTIM_ALIAS, '!another:ixo.test');
      await gw.aliasEvent(ROOM);
      await gw.deliver(message('@did-ixo-ixo1victim:ixo.test'));
      expect(gw.resolveCalls).toBe(2);
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
      // All three DID-authenticated messages run under their sender; moving
      // the alias cannot change that identity.
      expect(gw.turns.map((t) => t.userDid)).toEqual([
        VICTIM_DID,
        VICTIM_DID,
        VICTIM_DID,
      ]);
    });
  });

  it('a DID-shaped sender is attributed to their own DID, whatever the room claims', async () => {
    await withGateway('gw-did-sender', async (gw) => {
      gw.hs.aliasState.set(ROOM, VICTIM_ALIAS);
      gw.hs.directory.set(VICTIM_ALIAS, ROOM);
      await gw.deliver(message('@did-ixo-ixo1guest:ixo.test'));
      // The same DID minted on a server that is not its registered one.
      await gw.deliver(message('@did-ixo-ixo1victim:evil.example'));
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
      expect(gw.turns.map((t) => t.userDid)).toEqual(['did:ixo:ixo1guest']);
    });
  });
});

describe('the verified alias is used as room metadata', () => {
  it('an alias event arriving while the alias is checked does not cost a DID sender their turn', async () => {
    await withGateway('gw-alias-event-midway', async (gw, state) => {
      gw.hs.aliasState.set(ROOM, VICTIM_ALIAS);
      gw.hs.directory.set(VICTIM_ALIAS, ROOM);
      // An alt_aliases edit (or any alias event) lands while the directory
      // lookup is in flight: the memo is invalidated under the check.
      gw.beforeResolve = () => gw.aliasEvent(ROOM);
      await gw.deliver(message('@did-ixo-ixo1victim:ixo.test'));
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
      expect(gw.turns.map((t) => t.userDid)).toEqual([VICTIM_DID]);
      expect(listInboxRows(state.storage.sql)).toEqual([]);
    });
  });

  it('resolves a quote-reply thread while the alias and homeserver lookups are still in flight', async () => {
    await withGateway('gw-thread-parallel', async (gw) => {
      gw.hs.aliasState.set(ROOM, VICTIM_ALIAS);
      gw.hs.directory.set(VICTIM_ALIAS, ROOM);
      let release: () => void = () => undefined;
      const held = new Promise<void>((r) => {
        release = r;
      });
      gw.beforeResolve = () => held;
      const delivered = gw.deliver(
        message('@did-ixo-ixo1victim:ixo.test', {
          content: {
            msgtype: 'm.text',
            body: 'and this?',
            'm.relates_to': { 'm.in_reply_to': { event_id: '$quoted' } },
          },
        }),
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(gw.eventReads).toEqual(['$quoted']);
      release();
      await delivered;
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
      expect(gw.turns.map((t) => t.threadId)).toEqual(['$quoted']);
    });
  });
});

describe('homeserver failures while a message is prepared', () => {
  it('an alias lookup that fails keeps the row and retries it: neither dropped nor accepted', async () => {
    await withGateway('gw-alias-lookup-fails', async (gw, state) => {
      gw.hs.aliasState.set(ROOM, VICTIM_ALIAS);
      gw.hs.directory.set(VICTIM_ALIAS, ROOM);
      gw.hs.resolveFailures = 1;
      const msg = message('@did-ixo-ixo1victim:ixo.test');
      await gw.deliver(msg);
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
      expect(gw.turns).toEqual([]);
      expect(listInboxRows(state.storage.sql).map((r) => r.eventId)).toEqual(
        msg.eventIds,
      );
      await new Promise((r) =>
        setTimeout(r, SENDER_CHECK_RETRY_MS + DEBOUNCE_MS + 200),
      );
      expect(gw.turns.map((t) => t.userDid)).toEqual([VICTIM_DID]);
      expect(listInboxRows(state.storage.sql)).toEqual([]);
    });
  });

  it('a state read that fails once (rate limit) is retried after the timer and leads to the turn', async () => {
    await withGateway('gw-state-fails', async (gw, state) => {
      gw.hs.stateFailures = 1;
      const msg = message('@did-ixo-ixo1user:ixo.test');
      await expect(gw.deliver(msg)).resolves.toBeUndefined();
      expect(listInboxRows(state.storage.sql)).toHaveLength(1);
      await new Promise((r) =>
        setTimeout(r, SENDER_CHECK_RETRY_MS + DEBOUNCE_MS + 200),
      );
      expect(gw.turns.map((t) => t.eventIds)).toEqual([msg.eventIds]);
      expect(gw.sent.map((s) => s.kind)).toEqual(['text']);
    });
  });

  it('a turn a plugin gate refused is answered with one formatted notice in its thread, and its row dropped', async () => {
    await withGateway('gw-turn-refused', async (gw, state) => {
      gw.turnResult = async () => refusedResult(OUT_OF_CREDITS);
      const msg = message(USER);
      await gw.deliver(msg);
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
      expect(gw.turns).toHaveLength(1);
      // A direct room: no mention, the action as a line and a link.
      expect(gw.notices).toEqual([
        {
          roomId: ROOM,
          body: "You're out of IXO credits. Top up to keep chatting.\nTop up credits: https://portal.example/credits",
          opts: {
            threadId: gw.turns[0]!.threadId,
            formattedBody:
              'You\'re out of IXO credits. Top up to keep chatting.<br><a href="https://portal.example/credits">Top up credits</a>',
            txnId: expect.stringMatching(/-refused$/),
          },
        },
      ]);
      expect(listInboxRows(state.storage.sql)).toEqual([]);
    });
  });

  it('posts one notice per (room, user, code) in the window; a later refused message is dropped silently', async () => {
    await withGateway('gw-turn-refused-throttle', async (gw, state) => {
      gw.turnResult = async () => refusedResult(OUT_OF_CREDITS);
      await gw.deliver(message(USER));
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
      await gw.deliver(message(USER));
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
      expect(gw.turns).toHaveLength(2);
      expect(gw.notices).toHaveLength(1);
      // Both rows are gone: the second refusal is over, not pending.
      expect(listInboxRows(state.storage.sql)).toEqual([]);
      // Another code is its own notice.
      gw.turnResult = async () =>
        refusedResult({
          status: 503,
          code: 'credits_check_unavailable',
          message: 'Please try again in a minute.',
          details: { retryAfterSeconds: 60 },
        });
      await gw.deliver(message(USER));
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
      expect(gw.notices.map((n) => n.body)).toEqual([
        expect.stringContaining('out of IXO credits'),
        'Please try again in a minute.',
      ]);
    });
  });

  it('a turn allowed for the person clears the throttle: the next refusal is told again', async () => {
    await withGateway('gw-turn-refused-cleared', async (gw) => {
      gw.turnResult = async () => refusedResult(OUT_OF_CREDITS);
      await gw.deliver(message(USER));
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
      gw.turnResult = async () => ({
        sessionId: 's',
        requestId: 'r',
        text: 'reply',
        toolCalls: [],
      });
      await gw.deliver(message(USER));
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
      gw.turnResult = async () => refusedResult(OUT_OF_CREDITS);
      await gw.deliver(message(USER));
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
      expect(gw.sent.map((s) => s.kind)).toEqual(['notice', 'text', 'notice']);
    });
  });

  it('in a group room the notice mentions the refused person', async () => {
    await withGateway('gw-turn-refused-group', async (gw) => {
      vi.spyOn(GroupChatService.prototype, 'gate').mockResolvedValue({
        respond: true,
        reason: 'mentioned',
        roomKind: 'group',
        memberCount: 5,
        displayName: 'Alice <A>',
      });
      gw.turnResult = async () => refusedResult(OUT_OF_CREDITS);
      await gw.deliver(message(USER));
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
      expect(gw.notices).toHaveLength(1);
      const [notice] = gw.notices;
      expect(notice!.body).toBe(
        "Alice <A>: You're out of IXO credits. Top up to keep chatting.\nTop up credits: https://portal.example/credits",
      );
      expect(notice!.opts).toMatchObject({
        mentions: [USER],
        formattedBody: `<a href="https://matrix.to/#/${encodeURIComponent(USER)}">Alice &lt;A&gt;</a>: You're out of IXO credits. Top up to keep chatting.<br><a href="https://portal.example/credits">Top up credits</a>`,
      });
    });
  });

  it('a gateway that never posted a refusal notice keeps no throttle table', async () => {
    await withGateway('gw-no-refusal-table', async (gw, state) => {
      await gw.deliver(message(USER));
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
      expect(gw.sent.map((s) => s.kind)).toEqual(['text']);
      expect(
        state.storage.sql
          .exec(
            "SELECT name FROM sqlite_master WHERE name = 'refusal_notice_throttle'",
          )
          .toArray(),
      ).toEqual([]);
    });
  });

  it('a failing typing notice does not cost the user their turn', async () => {
    await withGateway('gw-typing-fails', async (gw, state) => {
      gw.hs.typingFails = true;
      await gw.deliver(message('@did-ixo-ixo1user:ixo.test'));
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
      expect(gw.turns).toHaveLength(1);
      expect(gw.sent).toEqual([{ kind: 'text', roomId: ROOM, body: 'reply' }]);
      expect(listInboxRows(state.storage.sql)).toEqual([]);
    });
  });
});

describe('inbox replay', () => {
  it('skips rows whose turn is queued behind a full gate (an in-place restart)', async () => {
    await withGateway(
      'gw-replay-queued',
      async (gw, state) => {
        let release: () => void = () => undefined;
        const held = new Promise<void>((r) => {
          release = r;
        });
        gw.turnResult = async () => {
          await held;
          return {
            sessionId: 's',
            requestId: 'r',
            text: 'reply',
            toolCalls: [],
          };
        };
        await gw.deliver(message('@did-ixo-ixo1a:ixo.test'));
        await gw.deliver(message('@did-ixo-ixo1b:ixo.test'));
        await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
        // One turn runs, the other waits for the single gate slot.
        expect(gw.turns).toHaveLength(1);
        await gw.restartReplay();
        await new Promise((r) => setTimeout(r, 50));
        expect(listInboxRows(state.storage.sql).map((r) => r.attempts)).toEqual(
          [0, 0],
        );
        release();
        await new Promise((r) => setTimeout(r, 100));
        expect(gw.turns).toHaveLength(2);
        expect(gw.sent.filter((s) => s.kind === 'notice')).toEqual([]);
        expect(listInboxRows(state.storage.sql)).toEqual([]);
      },
      { MATRIX_TURN_CONCURRENCY: '1' },
    );
  });

  it('does not replay a row still in the debounce window (a start in place, as a device rotation does)', async () => {
    await withGateway('gw-replay-debouncing', async (gw, state) => {
      const msg = message('@did-ixo-ixo1user:ixo.test');
      await gw.deliver(msg);
      await gw.restartReplay();
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
      expect(gw.turns.map((t) => t.eventIds)).toEqual([msg.eventIds]);
      expect(gw.turns[0]?.message).toBe(msg.body);
      expect(listInboxRows(state.storage.sql)).toEqual([]);
    });
  });

  it('replays a row whose debounce buffer a stop dropped', async () => {
    await withGateway('gw-replay-after-stop', async (gw, state) => {
      const msg = message('@did-ixo-ixo1user:ixo.test');
      await gw.deliver(msg);
      await gw.stop();
      expect(listInboxRows(state.storage.sql)).toHaveLength(1);
      await gw.restartReplay();
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
      expect(gw.turns.map((t) => t.eventIds)).toEqual([msg.eventIds]);
    });
  });

  it('a poison message is given up once its replays are used: one notice, row dropped, never again', async () => {
    await withGateway('gw-poison', async (gw, state) => {
      const sql = state.storage.sql;
      gw.restartReplay(); // creates the inbox table
      await new Promise((r) => setTimeout(r, 20));
      insertInboxRow(
        sql,
        {
          eventId: '$poison',
          roomId: ROOM,
          sender: '@did-ixo-ixo1user:ixo.test',
          ts: Date.now(),
          body: 'boom',
        },
        Date.now(),
      );
      sql.exec(
        `UPDATE turn_inbox SET attempts = ? WHERE event_id = ?`,
        MAX_TURN_REPLAYS,
        '$poison',
      );
      await gw.restartReplay();
      await new Promise((r) => setTimeout(r, 50));
      await gw.restartReplay();
      await new Promise((r) => setTimeout(r, 50));
      expect(gw.sent.filter((s) => s.kind === 'notice')).toHaveLength(1);
      expect(gw.turns).toEqual([]);
      expect(listInboxRows(sql)).toEqual([]);
    });
  });
});

describe('a gateway instance replaced by a newer one (a reset that keeps the isolate)', () => {
  // Production, Nov 2026: a Durable Object reset with unchanged code builds
  // the new instance in the same isolate while the old one runs on for
  // seconds. The old instance's timers (debounce buffers, the sender-check
  // retry, typing refreshes) and its turns in flight are not cancelled by
  // the reset; each of them must end without dispatching, sending, or
  // touching the inbox the live instance replays.
  it('dispatches nothing more, sends nothing, keeps the inbox rows; the new instance replays and answers them', async () => {
    const stub = env.SQLITE_TEST.get(
      env.SQLITE_TEST.idFromName('gw-superseded'),
    );
    await runInDurableObject(stub, async (_i: SqliteTestDO, state) => {
      const old = new TestGateway(state, gatewayEnv());
      let release: () => void = () => undefined;
      const held = new Promise<void>((r) => {
        release = r;
      });
      old.turnResult = async () => {
        await held;
        return { sessionId: 's', requestId: 'r', text: 'reply', toolCalls: [] };
      };
      // One turn in flight on the old instance…
      const first = message('@did-ixo-ixo1a:ixo.test');
      await old.deliver(first);
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
      expect(old.turns).toHaveLength(1);
      // …and one message still in its debounce buffer when the reset lands.
      const second = message('@did-ixo-ixo1b:ixo.test');
      await old.deliver(second);
      expect(listInboxRows(state.storage.sql)).toHaveLength(2);

      const live = new TestGateway(state, gatewayEnv());
      try {
        // The old instance's debounce timer fires: nothing is dispatched.
        await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 150));
        expect(old.turns).toHaveLength(1);
        // Its turn in flight comes back from the user object: no reply, no
        // "something went wrong" notice, and the inbox row stays.
        release();
        await new Promise((r) => setTimeout(r, 100));
        expect(old.sent).toEqual([]);
        expect(
          listInboxRows(state.storage.sql)
            .map((r) => r.eventId)
            .sort(),
        ).toEqual([...first.eventIds, ...second.eventIds].sort());
        // A replay asked of the old instance does nothing either.
        await old.restartReplay();
        await new Promise((r) => setTimeout(r, 50));
        expect(old.turns).toHaveLength(1);

        // The live instance replays both rows and answers each once.
        await live.restartReplay();
        await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 200));
        expect(live.turns.map((t) => t.eventIds[0]).sort()).toEqual(
          [...first.eventIds, ...second.eventIds].sort(),
        );
        expect(live.sent).toEqual([
          { kind: 'text', roomId: ROOM, body: 'reply' },
          { kind: 'text', roomId: ROOM, body: 'reply' },
        ]);
        expect(old.sent).toEqual([]);
        expect(listInboxRows(state.storage.sql)).toEqual([]);
      } finally {
        await live.stop().catch(() => undefined);
      }
    });
  });
});

describe('memos in front of storage', () => {
  it('two room lookups for a DID with no registered homeserver: one Blocksync request, no storage read the second time', async () => {
    await withGateway(
      'gw-memo',
      async (gw, state) => {
        const alias = `#did-ixo-ixo1newbie_did-ixo-ixo1oracle:ixo.test`;
        gw.hs.directory.set(alias, '!newbie:ixo.test');
        const fetches: string[] = [];
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
          fetches.push(String(input));
          return Response.json({
            data: {
              iids: { nodes: [{ id: 'did:ixo:ixo1newbie', service: [] }] },
            },
          });
        });
        const first = await gw.resolveUserRoom('did:ixo:ixo1newbie');
        const reads = vi.spyOn(state.storage, 'get');
        const second = await gw.resolveUserRoom('did:ixo:ixo1newbie');
        expect(first).toEqual({ roomId: '!newbie:ixo.test', alias });
        expect(second).toEqual(first);
        expect(fetches).toEqual(['https://blocksync.test/graphql']);
        expect(reads).not.toHaveBeenCalled();
        expect(gw.resolveCalls).toBe(1);
      },
      { BLOCKSYNC_GRAPHQL_URL: 'https://blocksync.test/graphql' },
    );
  });
});

describe('health and status', () => {
  it('GET /health answers the in-memory running flag without reading storage', async () => {
    await withGateway('gw-health', async (gw, state) => {
      const reads = vi.spyOn(state.storage, 'get');
      const sql = vi.spyOn(state.storage.sql, 'exec');
      const res = await gw.fetch(new Request('https://matrix-gateway/health'));
      expect(await res.json()).toEqual({ running: false });
      await gw.restartReplay();
      expect(gw.health()).toEqual({ running: true });
      expect(reads).not.toHaveBeenCalled();
      expect(
        sql.mock.calls.filter(([q]) => !String(q).includes('turn_inbox')),
      ).toEqual([]);
      expect(
        (await gw.fetch(new Request('https://matrix-gateway/other'))).status,
      ).toBe(404);
    });
  });
});

describe('planned recycle', () => {
  /** Signals far past any threshold: busy, recent inbound, pending rows. */
  const overdue = {
    sendsSinceBoot: 100_000,
    sendsBusy: 6,
    msSinceLastInbound: 0,
    pendingDurable: 12,
  };
  /** Idle signals past a 300-send threshold. */
  const idle = {
    sendsSinceBoot: 301,
    sendsBusy: 0,
    msSinceLastInbound: 60_000,
    pendingDurable: 0,
  };
  const policyOf = (resolved: { recycleAfterSends: number }) => ({
    afterSends: resolved.recycleAfterSends,
    quietForMs: 15_000,
  });

  it('is off by default: no send count, idle or overdue, recycles the bot', async () => {
    expect(DEFAULT_RECYCLE_AFTER_SENDS).toBe(0);
    await withGateway('gw-recycle-default', async (gw) => {
      const resolved = withDefaults(await gw.botOptions());
      expect(resolved.recycleAfterSends).toBe(0);
      expect(shouldRecycle(idle, policyOf(resolved))).toBe(false);
      expect(shouldRecycle(overdue, policyOf(resolved))).toBe(false);
    });
  });

  it('MATRIX_RECYCLE_AFTER_SENDS=0 is off as well', async () => {
    await withGateway(
      'gw-recycle-zero',
      async (gw) => {
        const resolved = withDefaults(await gw.botOptions());
        expect(resolved.recycleAfterSends).toBe(0);
        expect(shouldRecycle(overdue, policyOf(resolved))).toBe(false);
      },
      { MATRIX_RECYCLE_AFTER_SENDS: '0' },
    );
  });

  it('a positive MATRIX_RECYCLE_AFTER_SENDS opts back in', async () => {
    await withGateway(
      'gw-recycle-opt-in',
      async (gw) => {
        const resolved = withDefaults(await gw.botOptions());
        expect(resolved.recycleAfterSends).toBe(300);
        expect(shouldRecycle(idle, policyOf(resolved))).toBe(true);
        expect(
          shouldRecycle({ ...idle, sendsSinceBoot: 299 }, policyOf(resolved)),
        ).toBe(false);
        // Five thresholds in, it recycles under load too.
        expect(
          shouldRecycle(
            { ...overdue, sendsSinceBoot: 1_500 },
            policyOf(resolved),
          ),
        ).toBe(true);
      },
      { MATRIX_RECYCLE_AFTER_SENDS: '300' },
    );
  });
});

const ENCRYPTED_FILE = {
  v: 'v2',
  key: {
    kty: 'oct',
    key_ops: ['encrypt', 'decrypt'],
    alg: 'A256CTR',
    k: 'qcHVMSgYg-71CauWBezXI5qkaRb0LuIy-Wx5kIaHMIA',
    ext: true,
  },
  iv: 'X85+XgHN+HEAAAAAAAAAAA',
  hashes: { sha256: 'aWOHudBnDkJ9IwaR1Nd8XKoI7DOrqDTwt6xDPfVGN6Q' },
};

describe('media event info', () => {
  it('answers the media event as small JSON, the attachment left on the homeserver', async () => {
    await withGateway('gw-media-info', async (gw) => {
      gw.events.set('$enc', {
        type: 'm.room.message',
        content: {
          msgtype: 'm.image',
          body: 'photo.jpg',
          info: { mimetype: 'image/jpeg', size: 1234 },
          file: { url: 'mxc://hs.test/abc', ...ENCRYPTED_FILE },
        },
      });
      gw.events.set('$plain', {
        type: 'm.room.message',
        content: { msgtype: 'm.file', body: 'a.pdf', url: 'mxc://hs.test/p' },
      });
      gw.events.set('$redacted', { type: 'm.room.message', content: {} });
      gw.events.set('$bad', {
        type: 'm.room.message',
        content: {
          msgtype: 'm.file',
          file: { url: 'mxc://hs.test/x', ...ENCRYPTED_FILE, v: 'v1' },
        },
      });
      gw.mediaOpen = () => {
        throw new Error('the gateway must not open the media');
      };
      expect(await gw.eventMediaInfo(ROOM, '$enc')).toEqual({
        mxc: 'mxc://hs.test/abc',
        file: ENCRYPTED_FILE,
        mimetype: 'image/jpeg',
        filename: 'photo.jpg',
        size: 1234,
      });
      expect(await gw.eventMediaInfo(ROOM, '$plain')).toEqual({
        mxc: 'mxc://hs.test/p',
        filename: 'a.pdf',
      });
      expect(await gw.eventMediaInfo(ROOM, '$redacted')).toBeNull();
      expect(await gw.eventMediaInfo(ROOM, '$missing')).toBeNull();
      await expect(gw.eventMediaInfo(ROOM, '$bad')).rejects.toThrow(
        'unsupported version',
      );
    });
  });

  it('a lookup the homeserver never answers rejects at the bound, and a caller signal ends it sooner', async () => {
    await withGateway('gw-media-info-never', async (gw) => {
      gw.beforeEventRead = () => new Promise(() => undefined);
      await expect(
        gw.eventMediaInfo(ROOM, '$img', { timeoutMs: 50 }),
      ).rejects.toBeInstanceOf(MediaDownloadTimeoutError);
      const caller = new AbortController();
      const pending = gw.eventMediaInfo(ROOM, '$img', {
        timeoutMs: 60_000,
        signal: caller.signal,
      });
      caller.abort(new Error('turn aborted'));
      await expect(pending).rejects.toThrow('turn aborted');
    });
  });
});

describe('event sends', () => {
  it('never sends an attachment key into a room it does not see as encrypted', async () => {
    await withGateway('gw-send-refuse', async (gw) => {
      const send = vi
        .spyOn(MatrixBotDO.prototype, 'sendEvent')
        .mockResolvedValue('$sent');
      gw.roomEncrypted = false;
      const content = JSON.stringify({
        msgtype: 'm.image',
        body: 'photo.jpg',
        file: { url: 'mxc://hs.test/a', ...ENCRYPTED_FILE },
      });
      await expect(
        gw.sendEvent(ROOM, 'm.room.message', content),
      ).rejects.toThrow('not end-to-end encrypted');
      expect(send).not.toHaveBeenCalled();
      // Without a key, or in an encrypted room, the send goes through.
      await gw.sendEvent(
        ROOM,
        'm.room.message',
        '{"msgtype":"m.text","body":"x"}',
      );
      gw.roomEncrypted = true;
      await gw.sendEvent(ROOM, 'm.room.message', content, { txnId: 't1' });
      expect(send.mock.calls.map((call) => call[3])).toEqual([
        {},
        { txnId: 't1' },
      ]);
    });
  });

  it('holds background sends to a small lane, interactive ones never wait for it', async () => {
    await withGateway('gw-send-lane', async (gw) => {
      const held: Array<() => void> = [];
      let inFlight = 0;
      let most = 0;
      vi.spyOn(MatrixBotDO.prototype, 'sendEvent').mockImplementation(
        async (_room, _type, content) => {
          if (content.includes('reply')) return '$reply';
          inFlight += 1;
          most = Math.max(most, inFlight);
          await new Promise<void>((resolve) => held.push(resolve));
          inFlight -= 1;
          return '$file';
        },
      );
      const files = Array.from({ length: 5 }, (_, i) =>
        gw.sendEvent(ROOM, 'm.room.message', `{"body":"file ${i}"}`, {
          priority: 'background',
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(inFlight).toBe(BACKGROUND_SEND_CONCURRENCY);
      // A reply is not queued behind the waiting file events.
      await expect(
        gw.sendEvent(ROOM, 'm.room.message', '{"body":"reply"}'),
      ).resolves.toBe('$reply');
      while (held.length || inFlight) {
        held.splice(0).forEach((release) => release());
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      await Promise.all(files);
      expect(most).toBe(BACKGROUND_SEND_CONCURRENCY);
    });
  });
});

describe('plugin device credentials', () => {
  /** The homeserver's `whoami` and `login`, scripted. */
  function homeserver(opts: { validTokens: Set<string> }) {
    const calls: string[] = [];
    let logins = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(
        input instanceof Request ? input.headers : init?.headers,
      );
      calls.push(url.pathname);
      if (url.pathname.endsWith('/account/whoami')) {
        const token =
          headers.get('authorization')?.replace('Bearer ', '') ?? '';
        return opts.validTokens.has(token)
          ? Response.json({ user_id: BOT, device_id: 'PLUGINS' })
          : Response.json(
              { errcode: 'M_UNKNOWN_TOKEN', error: 'Unknown token' },
              { status: 401 },
            );
      }
      if (url.pathname.endsWith('/login')) {
        logins += 1;
        const token = `token-${logins}`;
        opts.validTokens.add(token);
        return Response.json({
          user_id: BOT,
          device_id: 'PLUGINS',
          access_token: token,
        });
      }
      return new Response('not found', { status: 404 });
    });
    return { calls, logins: () => logins };
  }

  it('lets concurrent first callers share one login, and re-logs in once when a caller reports the cached token rejected', async () => {
    await withGateway('gw-plugin-device', async (gw) => {
      const valid = new Set<string>();
      const hs = homeserver({ validTokens: valid });
      const herd = await Promise.all([
        gw.botCredentials(),
        gw.botCredentials(),
        gw.botCredentials(),
      ]);
      expect(new Set(herd.map((c) => c.accessToken))).toEqual(
        new Set(['token-1']),
      );
      expect(hs.logins()).toBe(1);

      // A caller holding a token that is no longer the cached one changes nothing.
      expect((await gw.botCredentials({ rejected: 'stale' })).accessToken).toBe(
        'token-1',
      );
      expect(hs.calls.filter((c) => c.endsWith('/login'))).toHaveLength(1);

      // The homeserver dropped the token: callers report it, one re-login serves them all.
      valid.delete('token-1');
      const recovered = await Promise.all([
        gw.botCredentials({ rejected: 'token-1' }),
        gw.botCredentials({ rejected: 'token-1' }),
      ]);
      expect(recovered.map((c) => c.accessToken)).toEqual([
        'token-2',
        'token-2',
      ]);
      expect(hs.logins()).toBe(2);
    });
  });
});

describe('room state in a room the oracle is only invited to', () => {
  const notJoined = () =>
    new MatrixError({ errcode: 'M_FORBIDDEN', error: 'User not in room' }, 403);

  async function withPlainGateway(
    name: string,
    fn: (gw: MatrixGatewayDO) => Promise<void>,
  ): Promise<void> {
    const stub = env.SQLITE_TEST.get(env.SQLITE_TEST.idFromName(name));
    await runInDurableObject(stub, async (_i: SqliteTestDO, state) => {
      const gw = new MatrixGatewayDO(state, gatewayEnv({ LOG_LEVEL: 'warn' }));
      try {
        await fn(gw);
      } finally {
        await gw.stop().catch(() => undefined);
      }
    });
  }

  it('a state write refused as not joined joins the room and is written (a new user during a bot restart)', async () => {
    await withPlainGateway('state-write-join', async (gw) => {
      const send = vi
        .spyOn(MatrixBotDO.prototype, 'sendStateEvent')
        .mockRejectedValueOnce(notJoined())
        .mockResolvedValueOnce('$state');
      const join = vi.spyOn(gw, 'joinRoom').mockResolvedValue(ROOM);
      await expect(
        gw.sendStateEvent(ROOM, 'ixo.room.state', '{}', 'ucan_delegation'),
      ).resolves.toBe('$state');
      expect(join).toHaveBeenCalledWith(ROOM);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenLastCalledWith(
        ROOM,
        'ixo.room.state',
        '{}',
        'ucan_delegation',
      );
    });
  });

  it('a state read refused as not joined joins and reads again', async () => {
    await withPlainGateway('state-read-join', async (gw) => {
      vi.spyOn(MatrixBotDO.prototype, 'getRoomStateEvent')
        .mockRejectedValueOnce(notJoined())
        .mockResolvedValueOnce('{"a":1}');
      const join = vi.spyOn(gw, 'joinRoom').mockResolvedValue(ROOM);
      await expect(
        gw.getRoomStateEvent(ROOM, 'ixo.room.state', 'ucan_delegation'),
      ).resolves.toBe('{"a":1}');
      expect(join).toHaveBeenCalledTimes(1);
    });
  });

  it('any other failure is thrown at once, with its message logged', async () => {
    await withPlainGateway('state-write-other', async (gw) => {
      vi.spyOn(MatrixBotDO.prototype, 'sendStateEvent').mockRejectedValue(
        new Error('M_LIMIT_EXCEEDED: Too many requests'),
      );
      const join = vi.spyOn(gw, 'joinRoom').mockResolvedValue(ROOM);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(
        gw.sendStateEvent(ROOM, 'ixo.room.state', '{}', 'ucan_delegation'),
      ).rejects.toThrow('M_LIMIT_EXCEEDED');
      expect(join).not.toHaveBeenCalled();
      expect(
        warn.mock.calls.some((call) =>
          String(call[0]).includes('Too many requests'),
        ),
      ).toBe(true);
    });
  });

  it('gives up after the grace period when joining does not help', async () => {
    await withPlainGateway('state-write-never', async (gw) => {
      vi.spyOn(MatrixBotDO.prototype, 'sendStateEvent').mockRejectedValue(
        notJoined(),
      );
      vi.spyOn(gw, 'joinRoom').mockRejectedValue(new Error('not invited'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(
        gw.sendStateEvent(ROOM, 'ixo.room.state', '{}', 'ucan_delegation'),
      ).rejects.toBeInstanceOf(MatrixError);
    });
  }, 15_000);
});

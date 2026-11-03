/**
 * `MatrixGatewayDO` on real Durable Object storage (the SQLite test object's
 * state), with the homeserver and the user objects scripted: who a room
 * message is attributed to (the verified room alias), what happens when the
 * homeserver fails while a message is prepared, the inbox replay caps, the
 * in-memory memos, the cheap status/health surface and the media event
 * lookup with its deadline.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { MatrixBotDO, type BotMessage } from '@ixo/matrix-bot-workers-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqliteTestDO } from '../sqlite/test-do';
import type { JsonString, OracleWorkerEnv, TurnResult } from '../do/contracts';
import { BACKGROUND_SEND_CONCURRENCY, MatrixGatewayDO } from './gateway-do';
import type { GateDecision } from './group-chat';
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

  override async sendNotice(roomId: string, body: string): Promise<string> {
    this.sent.push({ kind: 'notice', roomId, body });
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
/** The retry delay, shortened for the test (production: 60 s). */
const SENDER_CHECK_RETRY_MS = 300;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('attribution: the room alias must be verified', () => {
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

  it("a legacy sender on the alias's own server, in the room the alias resolves to, still gets their turn", async () => {
    await withGateway('gw-alias-legit', async (gw, state) => {
      gw.hs.aliasState.set(ROOM, VICTIM_ALIAS);
      gw.hs.directory.set(VICTIM_ALIAS, ROOM);
      await gw.deliver(message('@legacy:ixo.test'));
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
      expect(gw.turns.map((t) => [t.userDid, t.matrixUserId])).toEqual([
        [VICTIM_DID, '@legacy:ixo.test'],
      ]);
      expect(gw.sent).toEqual([{ kind: 'text', roomId: ROOM, body: 'reply' }]);
      expect(listInboxRows(state.storage.sql)).toEqual([]);
    });
  });

  it("memoises the verdict per room and asks again after the room's alias state changes", async () => {
    await withGateway('gw-alias-memo', async (gw) => {
      gw.hs.aliasState.set(ROOM, VICTIM_ALIAS);
      gw.hs.directory.set(VICTIM_ALIAS, ROOM);
      await gw.deliver(message('@legacy:ixo.test'));
      await gw.deliver(message('@legacy:ixo.test'));
      expect(gw.resolveCalls).toBe(1);
      // The alias is re-pointed elsewhere and the room's alias event arrives.
      gw.hs.directory.set(VICTIM_ALIAS, '!another:ixo.test');
      await gw.aliasEvent(ROOM);
      await gw.deliver(message('@legacy:ixo.test'));
      expect(gw.resolveCalls).toBe(2);
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
      // The first two (two bare messages: two threads) ran; the third, sent
      // after the alias moved away, was unmapped.
      expect(gw.turns.map((t) => t.userDid)).toEqual([VICTIM_DID, VICTIM_DID]);
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

describe('the verified alias is used as verified', () => {
  it('an alias event arriving while the alias is checked does not cost a legacy sender their turn', async () => {
    await withGateway('gw-alias-event-midway', async (gw, state) => {
      gw.hs.aliasState.set(ROOM, VICTIM_ALIAS);
      gw.hs.directory.set(VICTIM_ALIAS, ROOM);
      // An alt_aliases edit (or any alias event) lands while the directory
      // lookup is in flight: the memo is invalidated under the check.
      gw.beforeResolve = () => gw.aliasEvent(ROOM);
      await gw.deliver(message('@legacy:ixo.test'));
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
        message('@legacy:ixo.test', {
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
      const msg = message('@legacy:ixo.test');
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

/**
 * `MatrixGatewayDO` on real Durable Object storage (the SQLite test object's
 * state), with the homeserver and the user objects scripted: who a room
 * message is attributed to (the verified room alias), what happens when the
 * homeserver fails while a message is prepared, the inbox replay caps, the
 * in-memory memos, the cheap status/health surface and the media deadlines.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import type { BotMessage } from '@ixo/matrix-bot-workers-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqliteTestDO } from '../sqlite/test-do';
import type { JsonString, OracleWorkerEnv, TurnResult } from '../do/contracts';
import { MatrixGatewayDO } from './gateway-do';
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
    return null;
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

describe('media downloads', () => {
  it('a media stream that stalls mid-body errors once the bound passes', async () => {
    await withGateway('gw-media-stall', async (gw) => {
      gw.mediaOpen = async () => ({
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            // … and nothing more, ever.
          },
        }),
      });
      const media = await gw.downloadEventMediaStream(ROOM, '$img', {
        timeoutMs: 50,
      });
      const reader = media!.stream.getReader();
      expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3]));
      await expect(reader.read()).rejects.toThrow(
        'media download timed out after 50 ms',
      );
    });
  });

  it('a download that never opens rejects at the bound, and a caller signal ends it sooner', async () => {
    await withGateway('gw-media-never', async (gw) => {
      gw.mediaOpen = () => new Promise(() => undefined);
      await expect(
        gw.downloadEventMediaStream(ROOM, '$img', { timeoutMs: 50 }),
      ).rejects.toBeInstanceOf(MediaDownloadTimeoutError);
      const caller = new AbortController();
      const pending = gw.downloadEventMediaStream(ROOM, '$img', {
        timeoutMs: 60_000,
        signal: caller.signal,
      });
      caller.abort(new Error('turn aborted'));
      await expect(pending).rejects.toThrow('turn aborted');
    });
  });

  it('a complete download passes through untouched', async () => {
    await withGateway('gw-media-ok', async (gw) => {
      gw.mediaOpen = async () => ({
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([7, 8]));
            controller.close();
          },
        }),
      });
      const media = await gw.downloadEventMediaStream(ROOM, '$img', {
        timeoutMs: 1_000,
      });
      expect(
        new Uint8Array(await new Response(media!.stream).arrayBuffer()),
      ).toEqual(new Uint8Array([7, 8]));
    });
  });
});

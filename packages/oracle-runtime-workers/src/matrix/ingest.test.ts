import { describe, expect, it } from 'vitest';
import {
  aliasPartToDid,
  attributeUser,
  IngestPipeline,
  type IngestTurn,
  type InboundMessage,
  matrixUserIdToDid,
  resolveUserDid,
  serverNameOf,
  threadRootIdOf,
  userDidFromRoomAlias,
} from './ingest';

const ORACLE_DID = 'did:ixo:ixo1oracle';
const BOT = '@did-ixo-ixo1oracle:ixo.test';
const USER = '@did-ixo-ixo1user:ixo.test';
const ROOM = '!room:ixo.test';
const ALIAS = '#did-ixo-ixo1user_did-ixo-ixo1oracle:ixo.test';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every test user is registered on `ixo.test` unless a test says otherwise. */
const registeredOnIxoTest = (): string => 'ixo.test';

function harness(
  opts: {
    alias?: string | null;
    userServerName?: (userDid: string) => string | null;
  } = {},
) {
  const turns: IngestTurn[] = [];
  const pipeline = new IngestPipeline({
    oracleDid: ORACLE_DID,
    botUserId: BOT,
    debounceMs: 40,
    canonicalAlias: () => (opts.alias === undefined ? ALIAS : opts.alias),
    userServerName: opts.userServerName ?? registeredOnIxoTest,
    dispatch: async (turn) => {
      turns.push(turn);
    },
  });
  return { pipeline, turns };
}

let seq = 0;
function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  seq++;
  return {
    eventId: `$e${seq}`,
    roomId: ROOM,
    sender: USER,
    ts: Date.now(),
    body: `m${seq}`,
    ...over,
  };
}

describe('DID mapping', () => {
  it('maps alias parts and localparts back to DIDs', () => {
    expect(aliasPartToDid('did-ixo-ixo1abc')).toBe('did:ixo:ixo1abc');
    expect(aliasPartToDid('did-key-z6Mk-with-dash')).toBe(
      'did:key:z6Mk-with-dash',
    );
    expect(aliasPartToDid('alice')).toBeNull();
    expect(matrixUserIdToDid(USER)).toBe('did:ixo:ixo1user');
    expect(matrixUserIdToDid('@alice:ixo.test')).toBeNull();
    expect(matrixUserIdToDid('not-a-user-id')).toBeNull();
  });

  it('extracts the user DID from the canonical user↔oracle alias for THIS oracle only', () => {
    expect(userDidFromRoomAlias(ALIAS, ORACLE_DID)).toBe('did:ixo:ixo1user');
    expect(
      userDidFromRoomAlias(
        '#did-ixo-ixo1user_did-ixo-other:ixo.test',
        ORACLE_DID,
      ),
    ).toBeNull();
    expect(userDidFromRoomAlias('#general:ixo.test', ORACLE_DID)).toBeNull();
    expect(
      userDidFromRoomAlias('did-ixo-ixo1user_did-ixo-ixo1oracle', ORACLE_DID),
    ).toBeNull();
  });

  it('prefers the alias, falls back to the sender, and never attributes a DID sender to another user', () => {
    expect(
      resolveUserDid({ alias: ALIAS, sender: USER, oracleDid: ORACLE_DID }),
    ).toBe('did:ixo:ixo1user');
    expect(
      resolveUserDid({
        alias: ALIAS,
        sender: '@legacy:ixo.test',
        oracleDid: ORACLE_DID,
      }),
    ).toBe('did:ixo:ixo1user');
    expect(
      resolveUserDid({ alias: null, sender: USER, oracleDid: ORACLE_DID }),
    ).toBe('did:ixo:ixo1user');
    expect(
      resolveUserDid({
        alias: ALIAS,
        sender: '@did-ixo-ixo1guest:ixo.test',
        oracleDid: ORACLE_DID,
      }),
    ).toBe('did:ixo:ixo1guest');
    expect(
      resolveUserDid({
        alias: null,
        sender: '@legacy:ixo.test',
        oracleDid: ORACLE_DID,
      }),
    ).toBeNull();
  });

  it('names the server each identity was minted on', () => {
    expect(serverNameOf('@did-ixo-ixo1user:IXO.test')).toBe('ixo.test');
    expect(serverNameOf('@did-ixo-ixo1user:localhost:8008')).toBe(
      'localhost:8008',
    );
    expect(serverNameOf('@did-ixo-ixo1user')).toBeNull();
    expect(
      attributeUser({
        alias: ALIAS,
        sender: '@did-ixo-ixo1user:evil.example',
        oracleDid: ORACLE_DID,
      }),
    ).toEqual({ userDid: 'did:ixo:ixo1user', server: 'evil.example' });
    // A non-DID sender borrows the room owner's identity, so the alias's
    // server is the one that has to be the owner's.
    expect(
      attributeUser({
        alias: '#did-ixo-ixo1user_did-ixo-ixo1oracle:evil.example',
        sender: '@legacy:evil.example',
        oracleDid: ORACLE_DID,
      }),
    ).toEqual({ userDid: 'did:ixo:ixo1user', server: 'evil.example' });
  });

  it('the thread root is the session: a threaded message keys on its root, a bare one on itself', () => {
    expect(threadRootIdOf({ eventId: '$e', threadRootId: '$root' })).toBe(
      '$root',
    );
    expect(threadRootIdOf({ eventId: '$e' })).toBe('$e');
  });
});

describe('IngestPipeline', () => {
  it('drops empty and unmappable messages, queues the rest', () => {
    const { pipeline } = harness();
    expect(pipeline.offer(msg({ body: '   ' }))).toBe('empty');
    expect(pipeline.offer(msg())).toBe('queued');
    pipeline.clear();

    const unmapped = harness({ alias: null });
    expect(unmapped.pipeline.offer(msg({ sender: '@legacy:ixo.test' }))).toBe(
      'unmapped',
    );
  });

  it("drops a DID-shaped sender from a server that is not the DID's registered homeserver", async () => {
    const { pipeline, turns } = harness({ alias: null });
    expect(
      pipeline.offer(msg({ sender: '@did-ixo-ixo1user:evil.example' })),
    ).toBe('foreign');
    // Case-insensitive, like Matrix server names.
    expect(pipeline.offer(msg({ sender: '@did-ixo-ixo1user:IXO.test' }))).toBe(
      'queued',
    );
    await sleep(60);
    expect(turns.map((t) => t.userDid)).toEqual(['did:ixo:ixo1user']);
  });

  it("drops a non-DID sender in a room whose alias sits on a server that is not the owner's", () => {
    const forged = harness({
      alias: '#did-ixo-ixo1user_did-ixo-ixo1oracle:evil.example',
    });
    expect(forged.pipeline.offer(msg({ sender: '@legacy:evil.example' }))).toBe(
      'foreign',
    );

    const genuine = harness();
    expect(genuine.pipeline.offer(msg({ sender: '@legacy:ixo.test' }))).toBe(
      'queued',
    );
    genuine.pipeline.clear();
  });

  it("checks each speaker against their own DID's homeserver", () => {
    const { pipeline } = harness({
      userServerName: (did) =>
        did === 'did:ixo:ixo1guest' ? 'guest.example' : 'ixo.test',
    });
    expect(
      pipeline.offer(msg({ sender: '@did-ixo-ixo1guest:guest.example' })),
    ).toBe('queued');
    expect(pipeline.offer(msg({ sender: '@did-ixo-ixo1guest:ixo.test' }))).toBe(
      'foreign',
    );
    pipeline.clear();
  });

  it('drops the message when the registered homeserver is unknown', () => {
    const { pipeline } = harness({ userServerName: () => null });
    expect(pipeline.offer(msg())).toBe('foreign');
  });

  it('two speakers in one thread are two turns, each in their own user object', async () => {
    const { pipeline, turns } = harness();
    pipeline.offer(msg({ eventId: '$root', body: 'from user' }));
    pipeline.offer(
      msg({
        body: 'from guest',
        threadRootId: '$root',
        sender: '@did-ixo-ixo1guest:ixo.test',
      }),
    );
    await sleep(60);
    expect(
      turns
        .map((t) => [t.userDid, t.sessionId, t.message])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ['did:ixo:ixo1guest', '$root', 'from guest'],
      ['did:ixo:ixo1user', '$root', 'from user'],
    ]);
  });

  it('debounces per thread and dispatches one turn with the joined text', async () => {
    const { pipeline, turns } = harness();
    // A bare message and a follow-up threaded on it: one thread, one turn.
    pipeline.offer(msg({ eventId: '$one', body: 'one' }));
    pipeline.offer(msg({ eventId: '$two', body: 'two', threadRootId: '$one' }));
    pipeline.offer(msg({ body: 'in-thread', threadRootId: '$root' }));
    expect(pipeline.pendingCount).toBe(2);
    await sleep(120);
    expect(pipeline.pendingCount).toBe(0);
    expect(turns).toHaveLength(2);
    const opened = turns.find((t) => t.threadId === '$one');
    const thread = turns.find((t) => t.threadId === '$root');
    expect(opened).toMatchObject({
      userDid: 'did:ixo:ixo1user',
      matrixUserId: USER,
      roomId: ROOM,
      threadId: '$one',
      sessionId: '$one',
      message: 'one\ntwo',
    });
    expect(opened?.eventIds).toEqual(['$one', '$two']);
    expect(thread).toMatchObject({
      threadId: '$root',
      sessionId: '$root',
      message: 'in-thread',
    });
  });

  it('carries the gate metadata of the latest text message and rewrites the bot id like the Node bridge', async () => {
    const { pipeline, turns } = harness();
    pipeline.offer(
      msg({
        eventId: '$q',
        body: `hey ${BOT} look`,
        ts: 1000,
        inReplyTo: '$bot',
      }),
    );
    pipeline.offer(
      msg({
        eventId: '$m',
        body: 'and this',
        ts: 2000,
        threadRootId: '$q',
        mentionsBot: true,
      }),
    );
    await sleep(80);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      sourceEventId: '$m',
      ts: 2000,
      mentionsBot: true,
      message: 'hey (USER MENTIONED YOU @AI_AGENT) look\nand this',
    });
    expect(turns[0]?.inReplyTo).toBeUndefined();
    // A file-only burst takes its metadata from the file message.
    const fileOnly = harness();
    fileOnly.pipeline.offer(
      msg({
        eventId: '$f',
        body: '',
        ts: 3000,
        attachment: { eventId: '$f', filename: 'a.png', mimetype: 'image/png' },
        inReplyTo: '$bot',
      }),
    );
    await sleep(80);
    expect(fileOnly.turns[0]).toMatchObject({
      sourceEventId: '$f',
      ts: 3000,
      mentionsBot: false,
      inReplyTo: '$bot',
    });
  });

  it('two bare messages are two threads, two sessions — Node parity', async () => {
    const { pipeline, turns } = harness();
    pipeline.offer(msg({ eventId: '$a', body: 'first' }));
    pipeline.offer(msg({ eventId: '$b', body: 'second' }));
    expect(pipeline.pendingCount).toBe(2);
    await sleep(120);
    expect(turns.map((t) => [t.threadId, t.sessionId, t.message])).toEqual([
      ['$a', '$a', 'first'],
      ['$b', '$b', 'second'],
    ]);
  });

  it('extends the debounce window while messages keep arriving', async () => {
    const { pipeline, turns } = harness();
    pipeline.offer(msg({ eventId: '$a', body: 'a' }));
    await sleep(25);
    pipeline.offer(msg({ body: 'b', threadRootId: '$a' }));
    await sleep(25);
    expect(turns).toHaveLength(0);
    await sleep(60);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.message).toBe('a\nb');
  });

  it('reports dispatch failures through onError without losing later turns', async () => {
    const errors: string[] = [];
    let calls = 0;
    const pipeline = new IngestPipeline({
      oracleDid: ORACLE_DID,
      debounceMs: 10,
      canonicalAlias: () => ALIAS,
      userServerName: registeredOnIxoTest,
      dispatch: async () => {
        calls++;
        if (calls === 1) throw new Error('boom');
      },
      onError: (err, ctx) => errors.push(`${ctx}: ${(err as Error).message}`),
    });
    const first = msg();
    pipeline.offer(first);
    await sleep(40);
    pipeline.offer(msg());
    await sleep(40);
    expect(calls).toBe(2);
    expect(errors).toEqual([`dispatch ${first.eventId}: boom`]);
  });
});

describe('media messages', () => {
  it('turns a file-only send into a turn with the attachment and the Node wording', async () => {
    const { pipeline, turns } = harness();
    const attachment = {
      eventId: '$img',
      filename: 'photo.png',
      mimetype: 'image/png',
      size: 12,
    };
    expect(pipeline.offer(msg({ eventId: '$img', body: '', attachment }))).toBe(
      'queued',
    );
    await sleep(80);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.message).toBe('User shared a file: photo.png');
    expect(turns[0]?.attachments).toEqual([attachment]);
    expect(turns[0]?.eventIds).toEqual(['$img']);
  });

  it("pairs a caption sent in the file's thread with the file in one turn and still drops truly empty sends", async () => {
    const { pipeline, turns } = harness();
    const attachment = {
      eventId: '$doc',
      filename: 'report.pdf',
      mimetype: 'application/pdf',
    };
    expect(pipeline.offer(msg({ eventId: '$doc', body: '', attachment }))).toBe(
      'queued',
    );
    expect(
      pipeline.offer(
        msg({ body: 'please summarise this', threadRootId: '$doc' }),
      ),
    ).toBe('queued');
    expect(pipeline.offer(msg({ body: '   ' }))).toBe('empty');
    await sleep(80);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.message).toBe('please summarise this');
    expect(turns[0]?.attachments).toEqual([attachment]);
    expect(turns[0]?.eventIds).toHaveLength(2);
    expect(turns[0]?.threadId).toBe('$doc');
  });

  it('a bare caption after a bare file is its own thread — the file turn carries the Node wording', async () => {
    const { pipeline, turns } = harness();
    const attachment = {
      eventId: '$pic',
      filename: 'pic.png',
      mimetype: 'image/png',
    };
    pipeline.offer(msg({ eventId: '$pic', body: '', attachment }));
    pipeline.offer(msg({ eventId: '$cap', body: 'nice?' }));
    await sleep(80);
    expect(turns.map((t) => [t.threadId, t.message])).toEqual([
      ['$pic', 'User shared a file: pic.png'],
      ['$cap', 'nice?'],
    ]);
  });
});

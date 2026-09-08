import { describe, expect, it } from 'vitest';
import {
  aliasPartToDid,
  IngestPipeline,
  type IngestTurn,
  type InboundMessage,
  matrixUserIdToDid,
  resolveUserDid,
  sessionIdFor,
  userDidFromRoomAlias,
} from './ingest';

const ORACLE_DID = 'did:ixo:ixo1oracle';
const BOT = '@did-ixo-ixo1oracle:ixo.test';
const USER = '@did-ixo-ixo1user:ixo.test';
const ROOM = '!room:ixo.test';
const ALIAS = '#did-ixo-ixo1user_did-ixo-ixo1oracle:ixo.test';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function harness(opts: { alias?: string | null } = {}) {
  const turns: IngestTurn[] = [];
  const pipeline = new IngestPipeline({
    oracleDid: ORACLE_DID,
    debounceMs: 40,
    canonicalAlias: () => (opts.alias === undefined ? ALIAS : opts.alias),
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

  it('derives session ids per room / per thread', () => {
    expect(sessionIdFor(ROOM)).toBe(`matrix:${ROOM}`);
    expect(sessionIdFor(ROOM, '$root')).toBe('thread:$root');
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

  it('debounces per thread and dispatches one turn with the joined text', async () => {
    const { pipeline, turns } = harness();
    pipeline.offer(msg({ body: 'one' }));
    pipeline.offer(msg({ body: 'two' }));
    pipeline.offer(msg({ body: 'in-thread', threadRootId: '$root' }));
    expect(pipeline.pendingCount).toBe(2);
    await sleep(120);
    expect(pipeline.pendingCount).toBe(0);
    expect(turns).toHaveLength(2);
    const main = turns.find((t) => !t.threadId);
    const thread = turns.find((t) => t.threadId);
    expect(main).toMatchObject({
      userDid: 'did:ixo:ixo1user',
      matrixUserId: USER,
      roomId: ROOM,
      sessionId: `matrix:${ROOM}`,
      message: 'one\ntwo',
    });
    expect(main?.eventIds).toHaveLength(2);
    expect(thread).toMatchObject({
      threadId: '$root',
      sessionId: 'thread:$root',
      message: 'in-thread',
    });
  });

  it('extends the debounce window while messages keep arriving', async () => {
    const { pipeline, turns } = harness();
    pipeline.offer(msg({ body: 'a' }));
    await sleep(25);
    pipeline.offer(msg({ body: 'b' }));
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
      dispatch: async () => {
        calls++;
        if (calls === 1) throw new Error('boom');
      },
      onError: (err, ctx) => errors.push(`${ctx}: ${(err as Error).message}`),
    });
    pipeline.offer(msg());
    await sleep(40);
    pipeline.offer(msg());
    await sleep(40);
    expect(calls).toBe(2);
    expect(errors).toEqual([`dispatch matrix:${ROOM}: boom`]);
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

  it('pairs a caption with its file in one turn and still drops truly empty sends', async () => {
    const { pipeline, turns } = harness();
    const attachment = {
      eventId: '$doc',
      filename: 'report.pdf',
      mimetype: 'application/pdf',
    };
    expect(pipeline.offer(msg({ eventId: '$doc', body: '', attachment }))).toBe(
      'queued',
    );
    expect(pipeline.offer(msg({ body: 'please summarise this' }))).toBe(
      'queued',
    );
    expect(pipeline.offer(msg({ body: '   ' }))).toBe('empty');
    await sleep(80);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.message).toBe('please summarise this');
    expect(turns[0]?.attachments).toEqual([attachment]);
    expect(turns[0]?.eventIds).toHaveLength(2);
  });
});

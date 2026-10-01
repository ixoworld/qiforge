/**
 * The gateway's turn inbox over REAL SQLite-backed Durable Object storage
 * inside workerd, plus the pure replay plan and the reply transaction id.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { SqliteTestDO } from '../sqlite/test-do';
import {
  bumpInboxAttempts,
  countInboxRows,
  deleteInboxRows,
  ensureInboxTable,
  inboundOfRow,
  insertInboxRow,
  listInboxRows,
  MAX_TURN_REPLAYS,
  planInboxReplay,
  replyTxnId,
  settleOfferedRow,
  updateInboxThread,
  type InboxRow,
} from './inbox-store';
import { IngestPipeline, type InboundMessage } from './ingest';
import {
  type CachedUserServerName,
  lookupUserServerName,
} from './user-homeserver';

function stub(name: string): DurableObjectStub<SqliteTestDO> {
  return env.SQLITE_TEST.get(env.SQLITE_TEST.idFromName(name));
}

const msg = (
  id: string,
  extra: Partial<InboundMessage> = {},
): InboundMessage => ({
  eventId: id,
  roomId: '!room:ixo.test',
  sender: '@did-ixo-ixo1user:ixo.test',
  ts: 1_700_000_000_000 + Number(id.replace(/\D/g, '')),
  body: `message ${id}`,
  ...extra,
});

describe('turn inbox (SQLite)', () => {
  it('round-trips rows oldest first, keeps a thread root and an attachment, and deletes by event id', async () => {
    await runInDurableObject(stub('inbox-rt'), async (_instance, state) => {
      const sql = state.storage.sql;
      ensureInboxTable(sql);
      ensureInboxTable(sql); // idempotent
      insertInboxRow(sql, msg('$e2'), 2_000);
      insertInboxRow(
        sql,
        msg('$e1', {
          threadRootId: '$root',
          attachment: {
            eventId: '$e1',
            filename: 'a.png',
            mimetype: 'image/png',
            size: 12,
          },
        }),
        1_000,
      );
      insertInboxRow(sql, msg('$e1'), 9_999); // duplicate event id: ignored
      expect(countInboxRows(sql)).toBe(2);

      const rows = listInboxRows(sql);
      expect(rows.map((r) => r.eventId)).toEqual(['$e1', '$e2']);
      expect(rows[0]).toMatchObject({
        threadRootId: '$root',
        attachment: { filename: 'a.png', mimetype: 'image/png', size: 12 },
        receivedAt: 1_000,
        attempts: 0,
      });
      expect(rows[1]?.threadRootId).toBeUndefined();
      expect(rows[1]?.attachment).toBeUndefined();

      updateInboxThread(sql, '$e2', '$root2');
      expect(listInboxRows(sql)[1]?.threadRootId).toBe('$root2');

      const back = inboundOfRow(rows[0]!);
      expect(back).toEqual(
        msg('$e1', {
          threadRootId: '$root',
          attachment: {
            eventId: '$e1',
            filename: 'a.png',
            mimetype: 'image/png',
            size: 12,
          },
        }),
      );
      expect(back).not.toHaveProperty('attempts');

      bumpInboxAttempts(sql, ['$e1', '$missing']);
      expect(listInboxRows(sql)[0]?.attempts).toBe(1);

      deleteInboxRows(sql, ['$e1', '$e2', '$missing']);
      expect(countInboxRows(sql)).toBe(0);
    });
  });
});

/**
 * The gateway's sender check end to end over the real inbox: the homeserver
 * lookup (`lookupUserServerName`, Blocksync down), the memo the pipeline reads,
 * the offer, and what `offerInbound` does with the row.
 */
describe('sender check without a homeserver verdict (Blocksync down)', () => {
  const USER_DID = 'did:ixo:ixo1user';
  // Registered on another homeserver than the oracle's.
  const SENDER = '@did-ixo-ixo1user:devmx.ixo.earth';
  const TTL = 6 * 60 * 60_000;
  const blocksyncDown: typeof fetch = async () =>
    new Response('unavailable', { status: 503 });

  /** One gateway step: look the sender's server up, offer, settle the row. */
  async function offerAndSettle(
    sql: SqlStorage,
    cache: Map<string, CachedUserServerName>,
    inbound: InboundMessage,
  ) {
    const memo = new Map<string, string>();
    try {
      const { serverName } = await lookupUserServerName(USER_DID, {
        blocksyncGraphqlUrl: 'https://bs/graphql',
        defaultServerName: 'ixo.test',
        ttlMs: TTL,
        readCache: async (did) => cache.get(did),
        writeCache: async (did, entry) => {
          cache.set(did, entry);
        },
        fetchImpl: blocksyncDown,
      });
      memo.set(USER_DID, serverName);
    } catch {
      memo.delete(USER_DID);
    }
    const pipeline = new IngestPipeline({
      oracleDid: 'did:ixo:ixo1oracle',
      canonicalAlias: () => null,
      userServerName: (did) => memo.get(did) ?? null,
      dispatch: async () => undefined,
    });
    const outcome = pipeline.offer(inbound);
    pipeline.clear();
    return { outcome, row: settleOfferedRow(sql, inbound.eventId, outcome) };
  }

  it('(a) no cache: a live message keeps its row, and a replay keeps it again for the next one', async () => {
    await runInDurableObject(
      stub('inbox-unverified-nocache'),
      async (_instance, state) => {
        const sql = state.storage.sql;
        ensureInboxTable(sql);
        const cache = new Map<string, CachedUserServerName>();
        const live = msg('$live', { sender: SENDER });
        insertInboxRow(sql, live, 1_000);

        // Live delivery.
        await expect(offerAndSettle(sql, cache, live)).resolves.toEqual({
          outcome: 'unverified',
          row: 'kept',
        });
        expect(listInboxRows(sql).map((r) => r.eventId)).toEqual(['$live']);

        // Replay: planned, charged, still no verdict, still kept.
        const plan = planInboxReplay(listInboxRows(sql), {
          inFlight: new Set(),
          maxReplays: MAX_TURN_REPLAYS,
        });
        expect(plan.replay.map((r) => r.eventId)).toEqual(['$live']);
        bumpInboxAttempts(sql, ['$live']);
        await expect(
          offerAndSettle(sql, cache, inboundOfRow(plan.replay[0]!)),
        ).resolves.toEqual({ outcome: 'unverified', row: 'kept' });
        expect(listInboxRows(sql)).toMatchObject([
          { eventId: '$live', attempts: 1 },
        ]);
        expect(
          planInboxReplay(listInboxRows(sql), {
            inFlight: new Set(),
            maxReplays: MAX_TURN_REPLAYS,
          }).replay.map((r) => r.eventId),
        ).toEqual(['$live']);
      },
    );
  });

  it('(b) an expired cache entry: the stale server still admits the registered sender, and still refuses a forged one', async () => {
    await runInDurableObject(
      stub('inbox-unverified-stale'),
      async (_instance, state) => {
        const sql = state.storage.sql;
        ensureInboxTable(sql);
        const cache = new Map([
          [
            USER_DID,
            { serverName: 'devmx.ixo.earth', at: Date.now() - TTL - 60_000 },
          ],
        ]);
        const genuine = msg('$genuine', { sender: SENDER });
        const forged = msg('$forged', {
          sender: '@did-ixo-ixo1user:evil.example',
        });
        insertInboxRow(sql, genuine, 1_000);
        insertInboxRow(sql, forged, 1_001);

        await expect(offerAndSettle(sql, cache, genuine)).resolves.toEqual({
          outcome: 'queued',
          row: 'kept',
        });
        await expect(offerAndSettle(sql, cache, forged)).resolves.toEqual({
          outcome: 'foreign',
          row: 'deleted',
        });
        expect(listInboxRows(sql).map((r) => r.eventId)).toEqual(['$genuine']);
      },
    );
  });
});

describe('planInboxReplay', () => {
  const row = (id: string, attempts: number): InboxRow => ({
    ...msg(id),
    receivedAt: 0,
    attempts,
  });

  it('replays fresh rows, gives up on rows that used their replays, leaves running turns alone', () => {
    const plan = planInboxReplay(
      [row('$a', 0), row('$b', MAX_TURN_REPLAYS), row('$c', 1), row('$d', 0)],
      { inFlight: new Set(['$d']), maxReplays: MAX_TURN_REPLAYS },
    );
    expect(plan.replay.map((r) => r.eventId)).toEqual(['$a', '$c']);
    expect(plan.exhausted.map((r) => r.eventId)).toEqual(['$b']);
    expect(plan.skipped.map((r) => r.eventId)).toEqual(['$d']);
  });

  it('is empty for no rows', () => {
    expect(planInboxReplay([], { inFlight: new Set(), maxReplays: 2 })).toEqual(
      {
        replay: [],
        exhausted: [],
        skipped: [],
      },
    );
  });
});

describe('replyTxnId', () => {
  it('is deterministic per event and safe for the homeserver', () => {
    expect(replyTxnId('$abc-DEF_123')).toBe('reply-$abc-DEF_123');
    expect(replyTxnId('$abc-DEF_123')).toBe(replyTxnId('$abc-DEF_123'));
    // Room v3 event ids are standard base64: `/` and `+` are mapped.
    expect(replyTxnId('$a/b+c')).toBe('reply-$a_b-c');
    expect(replyTxnId('$a b\tc\nd')).toBe('reply-$abcd');
    expect(replyTxnId('$' + 'x'.repeat(400)).length).toBe(255);
    expect(replyTxnId('$e1')).not.toBe(replyTxnId('$e2'));
  });
});

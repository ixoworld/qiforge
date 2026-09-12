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
  updateInboxThread,
  type InboxRow,
} from './inbox-store';
import type { InboundMessage } from './ingest';

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

/**
 * The refused-turn room notice: its content (direct and group rooms, HTML
 * escaping, the call to action) and its throttle on real SQLite storage.
 * The gateway's use of both: `gateway-do.test.ts`.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { SqliteTestDO } from '../sqlite/test-do';
import {
  claimRefusalNotice,
  clearRefusalNotices,
  ensureRefusalNoticeTable,
  hasRefusalNoticeTable,
  matrixToUserLink,
  REFUSAL_NOTICE_WINDOW_MS,
  refusalNoticeContent,
  releaseRefusalNotice,
} from './refusal-notice';

const OUT_OF_CREDITS = {
  status: 402,
  code: 'insufficient_credits',
  message: "You're out of IXO credits. Top up to keep chatting.",
  details: {
    retryAfterSeconds: 3600,
    action: {
      label: 'Top up credits',
      url: 'https://portal.example/credits?topup=1&net=devnet',
    },
  },
};

describe('refusal notice content', () => {
  it('direct room: the message, then the action on its own line; HTML escaped, the action a link', () => {
    expect(
      refusalNoticeContent(OUT_OF_CREDITS, {
        roomKind: 'direct',
        userId: '@alice:ixo.test',
        displayName: 'Alice',
      }),
    ).toEqual({
      body: "You're out of IXO credits. Top up to keep chatting.\nTop up credits: https://portal.example/credits?topup=1&net=devnet",
      formattedBody:
        'You\'re out of IXO credits. Top up to keep chatting.<br><a href="https://portal.example/credits?topup=1&amp;net=devnet">Top up credits</a>',
    });
  });

  it('without an action: the message alone', () => {
    expect(
      refusalNoticeContent(
        {
          status: 503,
          code: 'credits_check_unavailable',
          message: 'Please try again in a minute.',
          details: { retryAfterSeconds: 60 },
        },
        { roomKind: 'direct', userId: '@a:x', displayName: 'A' },
      ),
    ).toEqual({
      body: 'Please try again in a minute.',
      formattedBody: 'Please try again in a minute.',
    });
  });

  it('escapes HTML in the message, the name and the label', () => {
    const content = refusalNoticeContent(
      {
        status: 403,
        message: '<b>no</b> & "never"\nsecond line',
        details: {
          action: { label: '<img src=x>', url: 'https://p.example/"x"' },
        },
      },
      {
        roomKind: 'group',
        userId: '@bob:ixo.test',
        displayName: '<script>Bob</script>',
      },
    );
    expect(content.formattedBody).toBe(
      '<a href="https://matrix.to/#/%40bob%3Aixo.test">&lt;script&gt;Bob&lt;/script&gt;</a>: &lt;b&gt;no&lt;/b&gt; &amp; &quot;never&quot;<br>second line<br><a href="https://p.example/%22x%22">&lt;img src=x&gt;</a>',
    );
  });

  it('group room: a mention of the refused person (m.mentions, matrix.to pill, display name in the body)', () => {
    expect(
      refusalNoticeContent(OUT_OF_CREDITS, {
        roomKind: 'group',
        userId: '@alice:ixo.test',
        displayName: 'Alice',
      }),
    ).toEqual({
      body: "Alice: You're out of IXO credits. Top up to keep chatting.\nTop up credits: https://portal.example/credits?topup=1&net=devnet",
      formattedBody:
        '<a href="https://matrix.to/#/%40alice%3Aixo.test">Alice</a>: You\'re out of IXO credits. Top up to keep chatting.<br><a href="https://portal.example/credits?topup=1&amp;net=devnet">Top up credits</a>',
      mentions: ['@alice:ixo.test'],
    });
  });

  it('group room without a display name: the localpart', () => {
    const content = refusalNoticeContent(
      { status: 403, message: 'No.' },
      {
        roomKind: 'group',
        userId: '@did-ixo-ixo1abc:ixo.test',
        displayName: '@did-ixo-ixo1abc:ixo.test',
      },
    );
    expect(content.body).toBe('did-ixo-ixo1abc: No.');
    expect(content.mentions).toEqual(['@did-ixo-ixo1abc:ixo.test']);
  });

  it('a matrix.to user link is percent-encoded', () => {
    expect(matrixToUserLink('@a+b/c:ixo.test')).toBe(
      'https://matrix.to/#/%40a%2Bb%2Fc%3Aixo.test',
    );
  });
});

async function withSql(
  name: string,
  fn: (sql: SqlStorage) => void,
): Promise<void> {
  const stub = env.SQLITE_TEST.get(env.SQLITE_TEST.idFromName(name));
  await runInDurableObject(stub, async (_i: SqliteTestDO, state) => {
    fn(state.storage.sql);
  });
}

describe('refusal notice throttle', () => {
  const key = { roomId: '!r:x', userId: '@a:x', code: 'insufficient_credits' };

  it('one claim per (room, user, code) per window; another code, user or room is its own', async () => {
    await withSql('refusal-throttle-window', (sql) => {
      expect(hasRefusalNoticeTable(sql)).toBe(false);
      ensureRefusalNoticeTable(sql);
      expect(hasRefusalNoticeTable(sql)).toBe(true);
      const t0 = 1_000_000;
      expect(claimRefusalNotice(sql, key, t0)).toBe(true);
      expect(claimRefusalNotice(sql, key, t0 + 1)).toBe(false);
      expect(
        claimRefusalNotice(sql, key, t0 + REFUSAL_NOTICE_WINDOW_MS - 1),
      ).toBe(false);
      expect(claimRefusalNotice(sql, { ...key, code: 'other' }, t0 + 2)).toBe(
        true,
      );
      expect(claimRefusalNotice(sql, { ...key, userId: '@b:x' }, t0 + 2)).toBe(
        true,
      );
      expect(claimRefusalNotice(sql, { ...key, roomId: '!s:x' }, t0 + 2)).toBe(
        true,
      );
      // The window has passed: told again.
      expect(claimRefusalNotice(sql, key, t0 + REFUSAL_NOTICE_WINDOW_MS)).toBe(
        true,
      );
    });
  });

  it('sweeps entries older than the window on every claim (bounded)', async () => {
    await withSql('refusal-throttle-sweep', (sql) => {
      ensureRefusalNoticeTable(sql);
      for (let i = 0; i < 50; i += 1)
        claimRefusalNotice(sql, { ...key, userId: `@u${i}:x` }, 1_000 + i);
      claimRefusalNotice(sql, key, 1_000 + REFUSAL_NOTICE_WINDOW_MS + 100);
      expect(
        sql
          .exec<{
            n: number;
          }>('SELECT COUNT(*) AS n FROM refusal_notice_throttle')
          .one().n,
      ).toBe(1);
    });
  });

  it('an allowed turn clears the person’s entries in that room only; a release gives a claim back', async () => {
    await withSql('refusal-throttle-clear', (sql) => {
      ensureRefusalNoticeTable(sql);
      const t0 = 5_000;
      claimRefusalNotice(sql, key, t0);
      claimRefusalNotice(sql, { ...key, code: 'other' }, t0);
      claimRefusalNotice(sql, { ...key, roomId: '!s:x' }, t0);
      clearRefusalNotices(sql, key.roomId, key.userId);
      expect(claimRefusalNotice(sql, key, t0 + 1)).toBe(true);
      expect(claimRefusalNotice(sql, { ...key, code: 'other' }, t0 + 1)).toBe(
        true,
      );
      expect(claimRefusalNotice(sql, { ...key, roomId: '!s:x' }, t0 + 1)).toBe(
        false,
      );
      releaseRefusalNotice(sql, key);
      expect(claimRefusalNotice(sql, key, t0 + 2)).toBe(true);
    });
  });
});

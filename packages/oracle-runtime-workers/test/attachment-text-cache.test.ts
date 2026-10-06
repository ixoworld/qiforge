/**
 * `AttachmentTextCacheStore` over a real `DoSqliteDatabase` inside workerd:
 * entries are scoped to (session, reference, model), bounded in size, and
 * dropped with their session. Runs inside the `TASKS_TEST` object's storage.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  AttachmentTextCacheStore,
  VIEW_CACHE_MAX_AGE_MS,
  VIEW_CACHE_MAX_CHARS,
  VIEW_CACHE_MAX_PER_SESSION,
} from '../src/attachments/view-cache';
import { DoSqliteDatabase } from '../src/sqlite/database';

describe('AttachmentTextCacheStore', () => {
  it('keys entries by session, reference and model, bounds them, and forgets a session', async () => {
    const stub = env.TASKS_TEST.get(
      env.TASKS_TEST.idFromName('attachment-text-cache'),
    );
    await runInDurableObject(stub, async (_instance, state) => {
      const db = await DoSqliteDatabase.open(state, 'view-cache-test.db');
      const store = new AttachmentTextCacheStore(db, console);
      const a = store.forSession('session-a');
      const b = store.forSession('session-b');

      expect(await a.get('$ev', 'vision/model')).toBeUndefined();
      await a.put('$ev', 'vision/model', 'a red square');
      await b.put('$ev', 'vision/model', 'another session');
      expect(await a.get('$ev', 'vision/model')).toBe('a red square');
      expect(await a.get('$ev', 'other/model')).toBeUndefined();
      expect(await a.get('$other', 'vision/model')).toBeUndefined();
      expect(await b.get('$ev', 'vision/model')).toBe('another session');

      await a.put('$big', 'vision/model', 'x'.repeat(VIEW_CACHE_MAX_CHARS + 1));
      expect(await a.get('$big', 'vision/model')).toBeUndefined();

      expect(await store.forgetSession('session-a')).toBe(1);
      expect(await a.get('$ev', 'vision/model')).toBeUndefined();
      expect(await b.get('$ev', 'vision/model')).toBe('another session');
    });
  });

  it('expires old entries, keeps the newest per session, and never caches http(s) references', async () => {
    const stub = env.TASKS_TEST.get(
      env.TASKS_TEST.idFromName('attachment-text-cache-bounds'),
    );
    await runInDurableObject(stub, async (_instance, state) => {
      const db = await DoSqliteDatabase.open(state, 'view-cache-bounds.db');
      let now = Date.UTC(2026, 0, 1);
      const store = new AttachmentTextCacheStore(db, console, () => now);
      const session = store.forSession('s');

      await session.put('$old', 'm', 'old text');
      now += VIEW_CACHE_MAX_AGE_MS + 1;
      // An expired entry is a miss, and the next write removes it.
      expect(await session.get('$old', 'm')).toBeUndefined();
      await session.put('$new', 'm', 'new text');
      expect(await store.forgetSession('s')).toBe(1);

      for (let i = 0; i <= VIEW_CACHE_MAX_PER_SESSION; i += 1) {
        now += 1;
        await session.put(`$ev${i}`, 'm', `text ${i}`);
      }
      expect(await session.get('$ev0', 'm')).toBeUndefined();
      expect(await session.get('$ev1', 'm')).toBe('text 1');
      expect(await session.get(`$ev${VIEW_CACHE_MAX_PER_SESSION}`, 'm')).toBe(
        `text ${VIEW_CACHE_MAX_PER_SESSION}`,
      );
      expect(await store.forgetSession('s')).toBe(VIEW_CACHE_MAX_PER_SESSION);

      // What a URL serves can change: http(s) references are never cached.
      await session.put('https://cdn.example/a.png', 'm', 'a red square');
      expect(
        await session.get('https://cdn.example/a.png', 'm'),
      ).toBeUndefined();
      expect(await store.forgetSession('s')).toBe(0);
    });
  });
});

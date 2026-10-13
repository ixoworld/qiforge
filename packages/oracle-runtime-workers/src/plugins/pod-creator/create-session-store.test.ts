import { describe, expect, it } from 'vitest';
import { createMemoryUserKv } from '../../core/user-kv';
import {
  CREATE_SESSION_NAMESPACE,
  KvCreateSessionStore,
} from './create-session-store';
import { THREAD, USER } from './test-fixtures';

/** The request that prepared the batch, and a later one (the user's reply). */
const PREP = 'req-prepare';
const LATER = 'req-later';

const freshStore = (
  options: ConstructorParameters<typeof KvCreateSessionStore>[1] = {},
  now?: () => number,
): KvCreateSessionStore =>
  new KvCreateSessionStore(createMemoryUserKv(now ? { now } : {}), options);

describe('KvCreateSessionStore', () => {
  it('approve binds only to the exact prepared batch', async () => {
    const store = freshStore();
    await store.prepared(USER, THREAD, 'blob_a', PREP);
    expect(await store.approve(USER, THREAD, 'blob_other', LATER)).toBe(
      'not-prepared',
    );
    expect(await store.approve(USER, 'thread-b', 'blob_a', LATER)).toBe(
      'not-prepared',
    );
    expect(await store.approve('did:ixo:user2', THREAD, 'blob_a', LATER)).toBe(
      'not-prepared',
    );
    expect(await store.approve(USER, THREAD, 'blob_a', LATER)).toBe('approved');
  });

  it('consume spends the approval — a second consume needs a fresh approve', async () => {
    const store = freshStore();
    await store.prepared(USER, THREAD, 'blob_a', PREP);
    await store.approve(USER, THREAD, 'blob_a', LATER);
    expect(await store.consume(USER, THREAD, 'blob_a')).toBe(true);
    expect(await store.consume(USER, THREAD, 'blob_a')).toBe(false);
    expect(await store.approve(USER, THREAD, 'blob_a', LATER)).toBe('approved');
    expect(await store.consume(USER, THREAD, 'blob_a')).toBe(true);
  });

  it('consume refuses an unapproved batch', async () => {
    const store = freshStore();
    await store.prepared(USER, THREAD, 'blob_a', PREP);
    expect(await store.consume(USER, THREAD, 'blob_a')).toBe(false);
  });

  it('a fresh prepare supersedes any prior approval', async () => {
    const store = freshStore();
    await store.prepared(USER, THREAD, 'blob_a', PREP);
    await store.approve(USER, THREAD, 'blob_a', LATER);
    await store.prepared(USER, THREAD, 'blob_b', PREP);
    expect(await store.consume(USER, THREAD, 'blob_a')).toBe(false);
    expect(await store.consume(USER, THREAD, 'blob_b')).toBe(false);
    expect(await store.approve(USER, THREAD, 'blob_b', LATER)).toBe('approved');
    expect(await store.consume(USER, THREAD, 'blob_b')).toBe(true);
  });

  it('clear drops the session', async () => {
    const store = freshStore();
    await store.prepared(USER, THREAD, 'blob_a', PREP);
    await store.approve(USER, THREAD, 'blob_a', LATER);
    await store.clear(USER, THREAD);
    expect(await store.consume(USER, THREAD, 'blob_a')).toBe(false);
  });

  it('sessions expire after idling past the TTL', async () => {
    let t = 0;
    const store = freshStore({ ttlMs: 1000 }, () => t);
    await store.prepared(USER, THREAD, 'blob_a', PREP);
    await store.approve(USER, THREAD, 'blob_a', LATER);
    t += 1000;
    expect(await store.consume(USER, THREAD, 'blob_a')).toBe(false);
  });

  it('approve and consume concurrently spend the approval at most once', async () => {
    const store = freshStore();
    await store.prepared(USER, THREAD, 'blob_a', PREP);
    await store.approve(USER, THREAD, 'blob_a', LATER);
    const results = await Promise.all([
      store.consume(USER, THREAD, 'blob_a'),
      store.consume(USER, THREAD, 'blob_a'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('treats an unreadable stored session as no session', async () => {
    const kv = createMemoryUserKv();
    await kv.set(CREATE_SESSION_NAMESPACE, JSON.stringify([USER, THREAD]), {
      preparedBlobId: 'blob_a',
      preparedRequestId: PREP,
      approved: 'yes',
    });
    const store = new KvCreateSessionStore(kv);
    expect(await store.approve(USER, THREAD, 'blob_a', LATER)).toBe(
      'not-prepared',
    );
    expect(await store.consume(USER, THREAD, 'blob_a')).toBe(false);
  });

  it('refuses approval from the request that prepared the batch', async () => {
    const store = freshStore();
    await store.prepared(USER, THREAD, 'blob_a', PREP);
    expect(await store.approve(USER, THREAD, 'blob_a', PREP)).toBe(
      'same-request',
    );
    expect(await store.consume(USER, THREAD, 'blob_a')).toBe(false);
    expect(await store.approve(USER, THREAD, 'blob_a', LATER)).toBe('approved');
    expect(await store.consume(USER, THREAD, 'blob_a')).toBe(true);
  });

  it('treats a session stored without the preparing request as no session', async () => {
    const kv = createMemoryUserKv();
    await kv.set(CREATE_SESSION_NAMESPACE, JSON.stringify([USER, THREAD]), {
      preparedBlobId: 'blob_a',
      approved: true,
    });
    const store = new KvCreateSessionStore(kv);
    expect(await store.approve(USER, THREAD, 'blob_a', LATER)).toBe(
      'not-prepared',
    );
    expect(await store.consume(USER, THREAD, 'blob_a')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { InMemoryCreateSessionStore } from './create-session-store.js';

const USER = 'did:ixo:user1';
const THREAD = 'session-1';

describe('InMemoryCreateSessionStore', () => {
  it('approve binds only to the exact prepared batch', async () => {
    const store = new InMemoryCreateSessionStore();
    await store.prepared(USER, THREAD, 'blob_a');
    expect(await store.approve(USER, THREAD, 'blob_other')).toBe(false);
    expect(await store.approve(USER, 'thread-b', 'blob_a')).toBe(false);
    expect(await store.approve('did:ixo:user2', THREAD, 'blob_a')).toBe(false);
    expect(await store.approve(USER, THREAD, 'blob_a')).toBe(true);
  });

  it('consume spends the approval — a second consume needs a fresh approve', async () => {
    const store = new InMemoryCreateSessionStore();
    await store.prepared(USER, THREAD, 'blob_a');
    await store.approve(USER, THREAD, 'blob_a');
    expect(await store.consume(USER, THREAD, 'blob_a')).toBe(true);
    expect(await store.consume(USER, THREAD, 'blob_a')).toBe(false);
    expect(await store.approve(USER, THREAD, 'blob_a')).toBe(true);
    expect(await store.consume(USER, THREAD, 'blob_a')).toBe(true);
  });

  it('consume refuses an unapproved batch', async () => {
    const store = new InMemoryCreateSessionStore();
    await store.prepared(USER, THREAD, 'blob_a');
    expect(await store.consume(USER, THREAD, 'blob_a')).toBe(false);
  });

  it('a fresh prepare supersedes any prior approval', async () => {
    const store = new InMemoryCreateSessionStore();
    await store.prepared(USER, THREAD, 'blob_a');
    await store.approve(USER, THREAD, 'blob_a');
    await store.prepared(USER, THREAD, 'blob_b');
    expect(await store.consume(USER, THREAD, 'blob_a')).toBe(false);
    expect(await store.consume(USER, THREAD, 'blob_b')).toBe(false);
    expect(await store.approve(USER, THREAD, 'blob_b')).toBe(true);
    expect(await store.consume(USER, THREAD, 'blob_b')).toBe(true);
  });

  it('clear drops the session', async () => {
    const store = new InMemoryCreateSessionStore();
    await store.prepared(USER, THREAD, 'blob_a');
    await store.approve(USER, THREAD, 'blob_a');
    await store.clear(USER, THREAD);
    expect(await store.consume(USER, THREAD, 'blob_a')).toBe(false);
  });

  it('sessions expire after idling past the TTL', async () => {
    let t = 0;
    const store = new InMemoryCreateSessionStore({
      ttlMs: 1000,
      now: () => t,
    });
    await store.prepared(USER, THREAD, 'blob_a');
    await store.approve(USER, THREAD, 'blob_a');
    t += 1000;
    expect(await store.consume(USER, THREAD, 'blob_a')).toBe(false);
  });
});

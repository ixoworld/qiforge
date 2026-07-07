import { describe, expect, it } from 'vitest';
import { InMemoryBlueprintStore } from './blueprint-store.js';
import type { BlueprintSection } from './blueprint-types.js';

const section = (role: string): BlueprintSection => ({
  role,
  stage: 'qualify',
  content: { note: role },
  recordedAt: '2026-06-12T00:00:00.000Z',
});

describe('InMemoryBlueprintStore', () => {
  it('init creates once and is idempotent for the same thread', async () => {
    const store = new InMemoryBlueprintStore();
    const first = await store.init('t1', 'solar monitoring');
    const second = await store.init('t1', 'a different brief');
    expect(first.brief).toBe('solar monitoring');
    expect(second.brief).toBe('solar monitoring');
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('init fills a missing brief on a later call, once', async () => {
    const store = new InMemoryBlueprintStore();
    await store.init('t1', undefined);
    const filled = await store.init('t1', 'late brief');
    expect(filled.brief).toBe('late brief');
    const again = await store.init('t1', 'even later');
    expect(again.brief).toBe('late brief');
  });

  it('returns snapshots — mutating a returned document does not leak back', async () => {
    const store = new InMemoryBlueprintStore();
    const bp = await store.init('t1', 'brief');
    bp.sections['forged'] = section('forged');
    const reread = await store.get('t1');
    expect(reread?.sections['forged']).toBeUndefined();
  });

  it('putSection auto-creates the document and replaces per role', async () => {
    const store = new InMemoryBlueprintStore();
    await store.putSection('t1', section('service_architect'));
    const updated = await store.putSection('t1', {
      ...section('service_architect'),
      content: { note: 'v2' },
    });
    expect(Object.keys(updated.sections)).toEqual(['service_architect']);
    expect(updated.sections['service_architect']?.content).toEqual({
      note: 'v2',
    });
  });

  it('reset discards the thread so a fresh design can start', async () => {
    const store = new InMemoryBlueprintStore();
    await store.init('t1', 'old brief');
    await store.reset('t1');
    expect(await store.get('t1')).toBeNull();
    const fresh = await store.init('t1', 'new brief');
    expect(fresh.brief).toBe('new brief');
    expect(Object.keys(fresh.sections)).toEqual([]);
  });

  it('expires sessions that idle past the TTL', async () => {
    let t = 0;
    const store = new InMemoryBlueprintStore({ ttlMs: 1000, now: () => t });
    await store.init('t1', 'brief');
    t += 1000;
    expect(await store.get('t1')).toBeNull();
  });

  it('evicts the least-recently-used session beyond the cap', async () => {
    const store = new InMemoryBlueprintStore({ maxEntries: 2 });
    await store.init('t1', 'one');
    await store.init('t2', 'two');
    await store.get('t1');
    await store.init('t3', 'three');
    expect(await store.get('t2')).toBeNull();
    expect((await store.get('t1'))?.brief).toBe('one');
    expect((await store.get('t3'))?.brief).toBe('three');
  });
});

import { describe, expect, it } from 'vitest';
import { IngestTextLru, INGEST_LRU_MAX_CHARS } from './view-cache';

const value = (text: string) => ({
  text,
  truncated: false,
  bytes: text.length,
  mimetype: 'text/plain',
});

describe('IngestTextLru', () => {
  it('keeps at most 4 entries and drops the least recently used', () => {
    const lru = new IngestTextLru();
    const s = lru.forSession('s');
    for (const n of ['a', 'b', 'c', 'd']) s.put(n, 'k', value(n));
    expect(s.get('a', 'k')?.text).toBe('a'); // touch a: now b is oldest
    s.put('e', 'k', value('e'));
    expect(lru.size).toBe(4);
    expect(s.get('b', 'k')).toBeUndefined();
    for (const n of ['a', 'c', 'd', 'e']) expect(s.get(n, 'k')).toBeDefined();
  });

  it('expires entries after 10 minutes', () => {
    let now = 1_000;
    const lru = new IngestTextLru({ now: () => now });
    const s = lru.forSession('s');
    s.put('a', 'k', value('a'));
    now += 10 * 60 * 1000 - 1;
    expect(s.get('a', 'k')).toBeDefined();
    now += 1;
    expect(s.get('a', 'k')).toBeUndefined();
    expect(lru.size).toBe(0);
  });

  it('holds 1 000 000 characters but not more', () => {
    const s = new IngestTextLru().forSession('s');
    s.put('ok', 'k', value('x'.repeat(INGEST_LRU_MAX_CHARS)));
    s.put('big', 'k', value('x'.repeat(INGEST_LRU_MAX_CHARS + 1)));
    expect(s.get('ok', 'k')).toBeDefined();
    expect(s.get('big', 'k')).toBeUndefined();
  });

  it('separates sessions and keys, and never caches http(s) refs', () => {
    const lru = new IngestTextLru();
    lru.forSession('s1').put('r', 'k1', value('one'));
    expect(lru.forSession('s2').get('r', 'k1')).toBeUndefined();
    expect(lru.forSession('s1').get('r', 'k2')).toBeUndefined();
    lru.forSession('s1').put('https://x.example/f', 'k', value('web'));
    expect(
      lru.forSession('s1').get('https://x.example/f', 'k'),
    ).toBeUndefined();
  });
});

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ResultStoreTestDO } from './result-store-test-do';
import {
  resultStoreKnobs,
  DEFAULT_RESULT_R2_MIN_BYTES,
  DEFAULT_RESULT_TTL_MS,
} from './result-store';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- augmenting the ambient `Cloudflare.Env` needs namespace syntax
  namespace Cloudflare {
    interface Env {
      RESULT_STORE_TEST: DurableObjectNamespace<ResultStoreTestDO>;
    }
  }
}

function stub(name: string) {
  return env.RESULT_STORE_TEST.get(env.RESULT_STORE_TEST.idFromName(name));
}

const T0 = Date.parse('2026-09-14T10:00:00.000Z');
const HOUR = 60 * 60 * 1000;

describe('ResultStore', () => {
  it('keeps a small result in SQLite, pages it by byte range, and de-duplicates by hash', async () => {
    const s = stub('results-small');
    await s.setNow(T0);
    const content = Array.from(
      { length: 200 },
      (_, i) => `line ${i} ${'x'.repeat(30)}`,
    ).join('\n');
    const ref = await s.put({
      sessionId: 'sess',
      toolName: 'mcp__dump',
      content,
    });
    expect(ref).toMatchObject({
      tier: 'sqlite',
      size: new TextEncoder().encode(content).length,
    });
    expect(ref!.id).toMatch(/^[a-f0-9]{64}$/);
    const first = await s.read(ref!.id, 0, 100);
    expect(first).toMatchObject({
      status: 'ok',
      offset: 0,
      length: 100,
      next: 100,
      tier: 'sqlite',
    });
    expect(first.status === 'ok' && first.text).toBe(content.slice(0, 100));
    const last = await s.read(ref!.id, ref!.size - 10, 1000);
    expect(last).toMatchObject({ status: 'ok', length: 10, next: null });
    expect(last.status === 'ok' && last.text).toBe(content.slice(-10));
    // Same content again: same id, no second row.
    const again = await s.put({
      sessionId: 'sess',
      toolName: 'mcp__dump',
      content,
    });
    expect(again?.id).toBe(ref!.id);
    expect((await s.stats()).rows).toBe(1);
    expect(await s.read('0'.repeat(64))).toEqual({ status: 'not-found' });
  });

  it('sends a large result to R2, reads ranges from there, and removes the object with the session', async () => {
    const s = stub('results-large');
    await s.setNow(T0);
    await s.configure({ r2MinBytes: 64 * 1024 });
    const content = 'R'.repeat(70 * 1024) + '\nTHE-END';
    const ref = await s.put({
      sessionId: 'sess',
      toolName: 'drill_big_result',
      content,
    });
    expect(ref?.tier).toBe('r2');
    expect(await s.r2Has(ref!.id)).toBe(true);
    const tail = await s.read(ref!.id, ref!.size - 7, 7);
    expect(tail.status === 'ok' && tail.text).toBe('THE-END');
    const stats = await s.stats();
    expect(stats).toMatchObject({ rows: 1, r2Rows: 1, sqliteBytes: 0 });
    expect(await s.deleteForSession('sess')).toBe(1);
    expect(await s.r2Has(ref!.id)).toBe(false);
    expect(await s.read(ref!.id)).toEqual({ status: 'not-found' });
  });

  it('expires results after the TTL: reads say so and the sweep removes rows and objects', async () => {
    const s = stub('results-expiry');
    await s.setNow(T0);
    await s.configure({ r2MinBytes: 64 * 1024 });
    const small = await s.put({
      sessionId: 'a',
      toolName: 't',
      content: 'small result',
    });
    const big = await s.put({
      sessionId: 'a',
      toolName: 't',
      content: 'B'.repeat(65 * 1024),
    });
    expect(big?.tier).toBe('r2');
    await s.setNow(T0 + 2 * HOUR); // TTL in the test DO is 1 h
    expect(await s.read(small!.id)).toEqual({ status: 'expired' });
    // Sweep clears what is left (the read above already removed `small`).
    expect(await s.sweep()).toBe(1);
    expect(await s.r2Has(big!.id)).toBe(false);
    expect((await s.stats()).rows).toBe(0);
  });

  it('refuses a result that fits neither tier instead of overflowing the row limit', async () => {
    const s = stub('results-nobucket');
    await s.setNow(T0);
    await s.configure({ withBucket: false });
    const ref = await s.put({
      sessionId: 'a',
      toolName: 't',
      content: 'Z'.repeat(1_600_000),
    });
    expect(ref).toBeUndefined();
    expect((await s.stats()).rows).toBe(0);
  });
});

describe('resultStoreKnobs', () => {
  it('parses hours and bytes with sane bounds', () => {
    expect(resultStoreKnobs({})).toEqual({
      ttlMs: DEFAULT_RESULT_TTL_MS,
      r2MinBytes: DEFAULT_RESULT_R2_MIN_BYTES,
    });
    expect(
      resultStoreKnobs({
        TOOL_RESULT_TTL_HOURS: '48',
        TOOL_RESULT_R2_MIN_BYTES: '500000',
      }),
    ).toEqual({
      ttlMs: 48 * HOUR,
      r2MinBytes: 500_000,
    });
    expect(
      resultStoreKnobs({
        TOOL_RESULT_TTL_HOURS: '0',
        TOOL_RESULT_R2_MIN_BYTES: '5000000',
      }),
    ).toEqual({
      ttlMs: DEFAULT_RESULT_TTL_MS,
      r2MinBytes: DEFAULT_RESULT_R2_MIN_BYTES,
    });
  });
});

describe('ResultStore paging over multi-byte text', () => {
  const pageAll = async (
    s: ReturnType<typeof stub>,
    id: string,
    length: number,
  ) => {
    let text = '';
    let offset: number | null = 0;
    let pages = 0;
    while (offset !== null) {
      const page = await s.read(id, offset, length);
      if (page.status !== 'ok') throw new Error(page.status);
      expect(page.offset).toBe(offset);
      expect(page.text).not.toContain('�');
      text += page.text;
      offset = page.next;
      pages += 1;
    }
    return { text, pages };
  };

  it('pages "é" × 5000 in 4001-byte chunks back to the exact text (SQLite tier)', async () => {
    const s = stub('results-utf8-sqlite');
    await s.setNow(T0);
    const content = 'é'.repeat(5000);
    const ref = await s.put({ sessionId: 'a', toolName: 't', content });
    expect(ref?.tier).toBe('sqlite');
    const { text, pages } = await pageAll(s, ref!.id, 4001);
    expect(text).toBe(content);
    expect(pages).toBe(3);
  });

  it('pages mixed 1-4 byte characters back to the exact text (R2 tier)', async () => {
    const s = stub('results-utf8-r2');
    await s.setNow(T0);
    await s.configure({ r2MinBytes: 64 * 1024 });
    const content = 'aé€😀'.repeat(8_000);
    const ref = await s.put({ sessionId: 'a', toolName: 't', content });
    expect(ref?.tier).toBe('r2');
    const { text } = await pageAll(s, ref!.id, 4001);
    expect(text).toBe(content);
  });

  it('an offset inside a character starts at that character; a chunk smaller than a character still returns it', async () => {
    const s = stub('results-utf8-edges');
    await s.setNow(T0);
    const content = '😀x';
    const ref = await s.put({ sessionId: 'a', toolName: 't', content });
    expect(await s.read(ref!.id, 2, 1)).toMatchObject({
      status: 'ok',
      offset: 0,
      length: 4,
      text: '😀',
      next: 4,
    });
    expect(await s.read(ref!.id, 4, 100)).toMatchObject({
      text: 'x',
      next: null,
    });
  });
});

describe('ResultStore removal', () => {
  it('keeps R2-tier rows whose object could not be deleted, and removes them once R2 is back', async () => {
    const s = stub('results-r2-outage');
    await s.setNow(T0);
    await s.configure({ r2MinBytes: 64 * 1024 });
    const big = await s.put({
      sessionId: 'a',
      toolName: 't',
      content: 'Q'.repeat(65 * 1024),
    });
    const small = await s.put({ sessionId: 'a', toolName: 't', content: 'q' });
    await s.setNow(T0 + 2 * HOUR);
    await s.configure({ failingDeletes: true });
    expect(await s.sweep()).toBe(2);
    expect(await s.r2Has(big!.id)).toBe(true);
    // The SQLite row went; the R2 row stays as the object's only record.
    expect(await s.stats()).toMatchObject({ rows: 1, r2Rows: 1 });
    expect(await s.read(small!.id)).toEqual({ status: 'not-found' });
    await s.configure({ failingDeletes: false });
    expect(await s.sweep()).toBe(1);
    expect(await s.r2Has(big!.id)).toBe(false);
    expect((await s.stats()).rows).toBe(0);
  });

  it('a session deleted during an R2 outage leaves its object to the next sweep', async () => {
    const s = stub('results-r2-outage-session');
    await s.setNow(T0);
    await s.configure({ r2MinBytes: 64 * 1024 });
    const big = await s.put({
      sessionId: 'a',
      toolName: 't',
      content: 'W'.repeat(65 * 1024),
    });
    await s.configure({ failingDeletes: true });
    await s.deleteForSession('a');
    expect(await s.read(big!.id)).toEqual({ status: 'expired' });
    expect(await s.r2Has(big!.id)).toBe(true);
    await s.configure({ failingDeletes: false });
    expect(await s.sweep()).toBe(1);
    expect(await s.r2Has(big!.id)).toBe(false);
  });

  it('removes many expired rows in one sweep', async () => {
    const s = stub('results-many');
    await s.setNow(T0);
    for (let i = 0; i < 250; i += 1)
      await s.put({ sessionId: `s${i % 3}`, toolName: 't', content: `r${i}` });
    await s.setNow(T0 + 2 * HOUR);
    expect(await s.sweep()).toBe(250);
    expect((await s.stats()).rows).toBe(0);
    expect(await s.references()).toEqual([]);
  });
});

describe('ResultStore results shared by sessions', () => {
  it('a result stored by two sessions survives the deletion of one', async () => {
    const s = stub('results-shared');
    await s.setNow(T0);
    await s.configure({ r2MinBytes: 64 * 1024 });
    const content = 'shared '.repeat(20_000);
    const a = await s.put({ sessionId: 'A', toolName: 't', content });
    const b = await s.put({ sessionId: 'B', toolName: 't', content });
    expect(b?.id).toBe(a!.id);
    const own = await s.put({ sessionId: 'A', toolName: 't', content: 'mine' });
    expect(await s.deleteForSession('A')).toBe(1);
    expect(await s.read(own!.id)).toEqual({ status: 'not-found' });
    expect(await s.read(a!.id, 0, 7)).toMatchObject({
      status: 'ok',
      text: 'shared ',
    });
    expect(await s.r2Has(a!.id)).toBe(true);
    expect(await s.deleteForSession('B')).toBe(1);
    expect(await s.read(a!.id)).toEqual({ status: 'not-found' });
    expect(await s.r2Has(a!.id)).toBe(false);
  });

  it('migrates rows stored before sharing to session references, once', async () => {
    const s = stub('results-migration');
    await s.setNow(T0);
    await s.seedLegacy([
      { id: 'legacy-1', sessionId: 'A', content: 'one' },
      { id: 'legacy-2', sessionId: 'B', content: 'two' },
    ]);
    // Same content from another session after the upgrade.
    const again = await s.put({ sessionId: 'B', toolName: 't', content: 'x' });
    expect(await s.references()).toEqual(
      [
        { id: 'legacy-1', session_id: 'A' },
        { id: 'legacy-2', session_id: 'B' },
        { id: again!.id, session_id: 'B' },
      ].sort((x, y) => x.id.localeCompare(y.id)),
    );
    await s.reboot();
    expect((await s.stats()).rows).toBe(3);
    expect(await s.references()).toHaveLength(3);
    expect(await s.deleteForSession('A')).toBe(1);
    expect(await s.read('legacy-1')).toEqual({ status: 'not-found' });
    expect(await s.read('legacy-2', 0, 3)).toMatchObject({ text: 'two' });
  });
});

describe('ResultStore after a failed R2 delete', () => {
  it('stores the content again when its kept row lost its object, so the result reads', async () => {
    const s = stub('results-revive');
    await s.setNow(T0);
    await s.configure({ r2MinBytes: 64 * 1024 });
    const content = 'V'.repeat(65 * 1024);
    const first = await s.put({ sessionId: 'a', toolName: 't', content });
    // The object is deleted, but R2's answer is lost: the row stays.
    await s.configure({ deletes: 'delete-then-fail' });
    await s.setNow(T0 + 2 * HOUR);
    expect(await s.sweep()).toBe(1);
    expect(await s.r2Has(first!.id)).toBe(false);
    expect((await s.stats()).rows).toBe(1);
    const again = await s.put({ sessionId: 'b', toolName: 't', content });
    expect(again?.id).toBe(first!.id);
    expect(await s.r2Has(first!.id)).toBe(true);
    expect(await s.read(first!.id, 0, 3)).toMatchObject({
      status: 'ok',
      text: 'VVV',
    });
  });

  it('keeps only the rows of the batch whose delete failed', async () => {
    const s = stub('results-batches');
    await s.setNow(T0);
    // Every result goes to R2; 1,001 of them take two delete calls.
    await s.configure({ r2MinBytes: 1 });
    for (let i = 0; i < 1_001; i += 1)
      await s.put({ sessionId: 'a', toolName: 't', content: `r${i}` });
    await s.configure({ deletes: 'fail-first' });
    // Open the store (its boot sweep finds nothing expired yet).
    expect((await s.stats()).rows).toBe(1_001);
    await s.setNow(T0 + 2 * HOUR);
    expect(await s.sweep()).toBe(1_001);
    expect((await s.stats()).rows).toBe(1_000);
  });

  it('a result stored again while its last session is being deleted survives', async () => {
    const s = stub('results-delete-race');
    await s.setNow(T0);
    await s.configure({ r2MinBytes: 64 * 1024 });
    const content = 'Z'.repeat(65 * 1024);
    await s.put({ sessionId: 'a', toolName: 't', content });
    expect(
      await s.deleteWhilePutting({ deleting: 'a', putting: 'b', content }),
    ).toMatchObject({ status: 'ok', text: 'ZZZZZ' });
  });
});

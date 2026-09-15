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

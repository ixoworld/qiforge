import { describe, expect, it } from 'vitest';
import { traceJson } from './json';

const opts = { maxChars: 1_000_000, maxDepth: 10 };

function json(value: unknown, o = opts): unknown {
  const result = traceJson(value, o);
  if (result.tooLarge) throw new Error('too large');
  return JSON.parse(result.json);
}

describe('traceJson', () => {
  it('writes what JSON.stringify writes for plain JSON', () => {
    const value = { a: [1, 'two', true, null, { b: 'é😀\n"' }], c: -0.5 };
    expect(traceJson(value, opts)).toMatchObject({
      tooLarge: false,
      json: JSON.stringify(value),
    });
  });

  it('measures exactly what it builds, and stops past its limit', () => {
    const value = {
      a: 'x'.repeat(1_000),
      b: Array.from({ length: 100 }, () => 'y'.repeat(100)),
    };
    const built = traceJson(value, opts);
    const measured = traceJson(value, { ...opts, measureOnly: true });
    expect(built.tooLarge).toBe(false);
    expect(measured.chars).toBe(built.tooLarge ? -1 : built.json.length);
    const capped = traceJson(value, { ...opts, maxChars: 500 });
    expect(capped.tooLarge).toBe(true);
    expect(capped.chars).toBeLessThan(2_000);
  });

  it('never escapes a string longer than what is left', () => {
    const huge = 'z'.repeat(50_000_000);
    const result = traceJson({ huge }, { ...opts, maxChars: 1_000 });
    expect(result.tooLarge).toBe(true);
  });

  it('bounds nesting with a marker', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 50; i += 1) deep = [deep];
    const out = JSON.stringify(json(deep));
    expect(out).toContain('{"_truncated":{"depth":10}}');
    expect(out).not.toContain('leaf');
  });

  it('writes an object reached twice without a cycle twice, a cycle once', () => {
    const shared = { s: 1 };
    const a: Record<string, unknown> = { x: shared, y: shared };
    a.self = a;
    expect(json(a)).toEqual({ x: { s: 1 }, y: { s: 1 }, self: '[Circular]' });
  });

  it('redacts signed links in strings and keys', () => {
    const sig = 'a'.repeat(64);
    const url = `https://r2.example/f?X-Amz-Signature=${sig}`;
    const out = JSON.stringify(json({ [url]: url }));
    expect(out).not.toContain(sig);
    expect(out).toContain('[redacted]');
  });

  it('is null for a value JSON cannot hold on its own', () => {
    expect(json(undefined)).toBeNull();
    expect(json(() => 1)).toBeNull();
    expect(json(Symbol('s'))).toBeNull();
  });
});

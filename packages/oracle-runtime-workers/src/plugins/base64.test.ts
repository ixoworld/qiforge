import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64 } from './base64';

/** Unchunked one-byte-at-a-time reference encoder. */
function reference(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

describe('base64 helpers', () => {
  it('round-trips an empty input', () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe('');
    expect(base64ToBytes('')).toEqual(new Uint8Array(0));
  });

  it('encodes every byte value like the reference encoder', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    const b64 = bytesToBase64(all);
    expect(b64).toBe(reference(all));
    expect([...base64ToBytes(b64)]).toEqual([...all]);
  });

  it('round-trips a multi-chunk payload past the fromCharCode argument limit', () => {
    // 3 MB + 1: spans many 32 KiB chunks and ends on a partial chunk.
    const big = new Uint8Array(3 * 1024 * 1024 + 1);
    for (let i = 0; i < big.length; i += 1) big[i] = (i * 31) & 0xff;
    const b64 = bytesToBase64(big);
    expect(b64).toBe(reference(big));
    expect(base64ToBytes(b64)).toEqual(big);
  });

  it('encodes only the bytes of a subarray view, not its backing buffer', () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
    expect(bytesToBase64(backing.subarray(2, 5))).toBe('AQID');
  });

  it('throws on malformed base64', () => {
    expect(() => base64ToBytes('not base64!')).toThrow();
  });
});

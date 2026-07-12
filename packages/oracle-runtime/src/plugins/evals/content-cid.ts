import { createHash } from 'node:crypto';

/**
 * Content-proof conventions mirrored byte-for-byte from the IXO Evals Engine
 * so references this plugin produces (trace CIDs, evidence packet digests)
 * recompute identically on the engine side:
 *
 * - Canonical JSON: recursive lexicographic key sort, `undefined` object
 *   values dropped, non-finite numbers rejected. For data free of `undefined`
 *   array elements this matches both engine canonicalizers (the governance
 *   one and the evidence-processing one), so one implementation serves both.
 * - CID: CIDv1, raw codec (0x55), multihash sha2-256 (0x12 0x20 + digest),
 *   multibase base32 lowercase (`b` prefix) — `bafk…` identifiers identical
 *   to IPFS raw-leaf blocks.
 * - Packet digest: `sha256:<hex>` over the canonical JSON string — the value
 *   the engine compares an evidence envelope's `integrity.sha256` against.
 */

export function canonicalJsonString(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return JSON.stringify(value);
  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('canonicalJsonString: non-finite number');
    }
    return JSON.stringify(value);
  }
  if (t === 'undefined' || t === 'function' || t === 'symbol') {
    throw new Error(`canonicalJsonString: unsupported ${t}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJsonString(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJsonString(obj[k])}`)
    .join(',')}}`;
}

const RFC4648_LOWER = 'abcdefghijklmnopqrstuvwxyz234567';

/** Multibase base32 (lowercase, no padding, `b` prefix) of arbitrary bytes. */
function base32LowerMultibase(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = 'b';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += RFC4648_LOWER[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += RFC4648_LOWER[(value << (5 - bits)) & 31];
  return out;
}

/** CIDv1 (raw codec, sha2-256) over `bytes`. */
export function cidV1RawSha256(bytes: Uint8Array): string {
  const digest = createHash('sha256').update(Buffer.from(bytes)).digest();
  const cidBytes = new Uint8Array(4 + digest.length);
  cidBytes[0] = 0x01; // CIDv1
  cidBytes[1] = 0x55; // raw codec
  cidBytes[2] = 0x12; // sha2-256
  cidBytes[3] = 0x20; // 32-byte digest length
  cidBytes.set(digest, 4);
  return base32LowerMultibase(cidBytes);
}

/** CIDv1 (raw codec, sha2-256) over the UTF-8 encoding of `text`. */
export function cidV1RawSha256Utf8(text: string): string {
  return cidV1RawSha256(new TextEncoder().encode(text));
}

/** `sha256:<hex>` digest of a value's canonical JSON — the engine's evidence packet digest. */
export function sha256DigestOfCanonicalJson(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJsonString(value)).digest('hex')}`;
}

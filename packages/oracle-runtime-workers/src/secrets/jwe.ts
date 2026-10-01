/**
 * Compact-JWE primitives for per-room secrets — a byte-for-byte port of
 * `@ixo/oracles-chain-client`'s `matrix-bot/jwe-utils.ts` (the scheme the
 * portal uses when a user deposits a room secret for an oracle):
 *
 *   - key agreement: `ECDH-ES+A256KW` over a P-256 keypair
 *   - content encryption: `A256GCM`
 *   - serialization: compact JWE
 *
 * Pure `jose` over WebCrypto, so it runs identically on Workers and Node —
 * a secret written by the portal (or the Node runtime) decrypts here and
 * vice versa.
 */
import { CompactEncrypt, compactDecrypt, importJWK, type JWK } from 'jose';

export type { JWK };

const JWE_ALG = 'ECDH-ES+A256KW';
const JWE_ENC = 'A256GCM';

/** Decrypt a compact JWE with the oracle's P-256 private JWK → UTF-8 plaintext. */
export async function decryptJwe(
  compact: string,
  privateJwk: JWK,
): Promise<string> {
  const key = await importJWK(privateJwk, JWE_ALG);
  const { plaintext } = await compactDecrypt(compact, key);
  return new TextDecoder().decode(plaintext);
}

/**
 * Compact-JWE encrypt to a P-256 public key (`ECDH-ES+A256KW` / `A256GCM`).
 * Accepts a private JWK too: `d` is stripped so callers holding only the
 * oracle's own keypair can encrypt to themselves (e.g. writing back a
 * refreshed OAuth token) — same contract as the chain-client's `encryptJWE`.
 */
export async function encryptJwe(plaintext: string, jwk: JWK): Promise<string> {
  const { d: _d, ...publicJwk } = jwk;
  const key = await importJWK(publicJwk, JWE_ALG);
  return new CompactEncrypt(new TextEncoder().encode(plaintext))
    .setProtectedHeader({ alg: JWE_ALG, enc: JWE_ENC })
    .encrypt(key);
}

/**
 * Parse a JSON-encoded EC JWK (as returned by the gateway's
 * `getOracleSecretsKey` — the oracle key is always P-256). Returns `null` on
 * anything malformed so a corrupted key degrades to "no key seated" instead
 * of throwing on the boot path. Unknown fields are dropped.
 */
export function parseJwk(json: string): JWK | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const { kty, crv, x, y, d, kid } = parsed as Record<string, unknown>;
  if (kty !== 'EC') return null;
  if (
    typeof crv !== 'string' ||
    typeof x !== 'string' ||
    typeof y !== 'string'
  ) {
    return null;
  }
  const jwk: JWK = { kty: 'EC', crv, x, y };
  if (typeof d === 'string') jwk.d = d;
  if (typeof kid === 'string') jwk.kid = kid;
  return jwk;
}

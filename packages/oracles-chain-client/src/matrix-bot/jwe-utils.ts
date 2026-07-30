import { CompactEncrypt, compactDecrypt, importJWK, type JWK } from 'jose';

export type { JWK };

export async function decryptJWE(
  jwe: string,
  privateJwk: JWK,
): Promise<string> {
  const key = await importJWK(privateJwk, 'ECDH-ES+A256KW');
  const { plaintext } = await compactDecrypt(jwe, key);
  return new TextDecoder().decode(plaintext);
}

/**
 * Compact-JWE encrypt to a P-256 public key (`ECDH-ES+A256KW` / `A256GCM`) —
 * the same scheme the portal uses when a user deposits a room secret for an
 * oracle. Accepts a private JWK too: `d` is stripped so callers holding only
 * the oracle's own keypair can encrypt to themselves (e.g. writing back a
 * refreshed OAuth token).
 */
export async function encryptJWE(plaintext: string, jwk: JWK): Promise<string> {
  const { d: _d, ...publicJwk } = jwk;
  const key = await importJWK(publicJwk, 'ECDH-ES+A256KW');
  return new CompactEncrypt(new TextEncoder().encode(plaintext))
    .setProtectedHeader({ alg: 'ECDH-ES+A256KW', enc: 'A256GCM' })
    .encrypt(key);
}

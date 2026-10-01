import { generateKeyPair, exportJWK } from 'jose';
import { describe, expect, it } from 'vitest';
import { decryptJwe, encryptJwe, parseJwk, type JWK } from './jwe';

/**
 * Known-good fixture minted by executing the *chain-client's own scheme*
 * (`packages/oracles-chain-client/src/matrix-bot/jwe-utils.ts` `encryptJWE`,
 * reproduced verbatim against its installed jose) — proves this port
 * decrypts what the portal / Node runtime encrypts. ECDH-ES ciphertexts are
 * randomized per encryption, but decryption is deterministic.
 */
const FIXTURE_PRIVATE_JWK: JWK = {
  kty: 'EC',
  x: 'gqkVlNyDyDJh6rjETzi8n-QAkpw650EttnEYuoF5Hik',
  y: 'XDq_aifv0GqaptO9Vi5fXAUFNa5LRu8B8UrbJHN5oog',
  crv: 'P-256',
  d: 'uXjaCXlbT8Xd_E9D0fY-psDml4spIeCyIjFm2aK5ZlA',
};
const FIXTURE_PLAINTEXT = 'byo-secret-value: sk-test-1234567890';
const FIXTURE_JWE =
  'eyJhbGciOiJFQ0RILUVTK0EyNTZLVyIsImVuYyI6IkEyNTZHQ00iLCJlcGsiOnsieCI6IjhhdC1tVG9MbnNjQ25WZ0labHl1NlNQZG82UUE0M1dkbEVVc3pPbzQ0ZjgiLCJjcnYiOiJQLTI1NiIsImt0eSI6IkVDIiwieSI6Ik5zVEpKeUtRbG4wWXN2eFMwekYtQWNkeW9pTWtWMHhJVUdGb1JxblVMbW8ifX0.J_G2qeBvkXUASo94QsZIV8w-j4xzKhSAvsym7o1vLpUhbC8vUHBu6w.3WTrmHcNIhLgRJOz.O3kel1KtwK4JUW1Jvz_oMZsF1-tGEqnIOKeOeoW-FDyh01a9.zhgqR_EIeMZyBX7lNdTggg';

describe('jwe (ECDH-ES+A256KW / A256GCM compact JWE)', () => {
  it('decrypts a ciphertext produced by the chain-client scheme', async () => {
    await expect(decryptJwe(FIXTURE_JWE, FIXTURE_PRIVATE_JWK)).resolves.toBe(
      FIXTURE_PLAINTEXT,
    );
  });

  it('round-trips: encryptJwe output decrypts with the private key', async () => {
    const plaintext = 'a secret with unicode — ✓ / newlines\nand more';
    const jwe = await encryptJwe(plaintext, FIXTURE_PRIVATE_JWK);
    // Header advertises the exact wire scheme the portal expects.
    const headerB64 = jwe.split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/');
    const header = JSON.parse(
      atob(headerB64.padEnd(Math.ceil(headerB64.length / 4) * 4, '=')),
    ) as { alg: string; enc: string };
    expect(header.alg).toBe('ECDH-ES+A256KW');
    expect(header.enc).toBe('A256GCM');
    await expect(decryptJwe(jwe, FIXTURE_PRIVATE_JWK)).resolves.toBe(plaintext);
  });

  it('encrypts to a public-only JWK (d stripped by the caller contract)', async () => {
    const { d: _d, ...publicJwk } = FIXTURE_PRIVATE_JWK;
    const jwe = await encryptJwe('to-self', publicJwk);
    await expect(decryptJwe(jwe, FIXTURE_PRIVATE_JWK)).resolves.toBe('to-self');
  });

  it('fails to decrypt with the wrong private key', async () => {
    const { privateKey } = await generateKeyPair('ECDH-ES+A256KW', {
      crv: 'P-256',
      extractable: true,
    });
    const wrongJwk = await exportJWK(privateKey);
    await expect(decryptJwe(FIXTURE_JWE, wrongJwk)).rejects.toThrow();
  });

  describe('parseJwk', () => {
    it('parses a valid private JWK JSON', () => {
      const jwk = parseJwk(JSON.stringify(FIXTURE_PRIVATE_JWK));
      expect(jwk).toEqual(FIXTURE_PRIVATE_JWK);
    });

    it('returns null for malformed input', () => {
      expect(parseJwk('not json')).toBeNull();
      expect(parseJwk('42')).toBeNull();
      expect(parseJwk('[]')).toBeNull();
      expect(parseJwk(JSON.stringify({ crv: 'P-256' }))).toBeNull();
      // Missing coordinates.
      expect(parseJwk(JSON.stringify({ kty: 'EC', crv: 'P-256' }))).toBeNull();
    });

    it('drops unknown fields', () => {
      const jwk = parseJwk(
        JSON.stringify({
          ...FIXTURE_PRIVATE_JWK,
          evil: { nested: 1 },
          alg: 'ECDH-ES+A256KW',
        }),
      );
      expect(jwk).toEqual(FIXTURE_PRIVATE_JWK);
    });
  });
});

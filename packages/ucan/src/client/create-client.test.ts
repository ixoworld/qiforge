import { describe, expect, it } from 'vitest';
import { ed25519 } from '@ucanto/principal';
import { parseSigner, signerFromMnemonic } from './create-client.js';

/**
 * GOLDEN VECTORS — generated with the ORIGINAL @cosmjs/crypto (libsodium) implementation of
 * `signerFromMnemonic` before it was replaced with the pure-JS derivation (WebCrypto SHA-256 +
 * ucanto `ed25519.derive`). These pin the derivation contract byte-for-byte:
 *
 *   seed = SHA256(utf8(mnemonic.trim()))[0..32) → Ed25519 keypair
 *   privateKey = 'M' + base64pad([0x80,0x26] + seed(32) + [0xed,0x01] + pubkey(32))
 *
 * If these ever fail, the derived keys no longer match the verification methods registered
 * on-chain — that is a breaking change, not a test to update.
 */
const GOLDEN_VECTORS = [
  {
    mnemonic:
      'test walk nut penalty hip pave soap entry language right filter choice',
    did: 'did:key:z6Mkewi4Ko5asBsD3ihaHLAMYZJLx7DWJuRgkgPsme4yect7',
    privateKey:
      'MgCbkMwR9mL9STR39eTw2NNIOxsuPaF/w2cwo2mFQvp/bpO0BB0ms3SLsNb7m0aquWmOcC6Xx8EQiDH6LraZ3897K4ug=',
  },
  {
    mnemonic:
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    did: 'did:key:z6MkpPcjwo4wP49VnvG7isXnqvFJyEqZ5JxSjohHxTT9Zr1c',
    privateKey:
      'MgCbFV+7IeN/YUro/iAh8TzUPCcVVN6teVJw80UMg7DzvOO0Bk6XyYZhJMeDfXHQ0sW1GjvsZUwmNPK1PoVBrngUuf8c=',
  },
] as const;

describe('signerFromMnemonic', () => {
  it.each(GOLDEN_VECTORS)(
    'derives the same key as the original cosmjs implementation ($did)',
    async ({ mnemonic, did, privateKey }) => {
      const result = await signerFromMnemonic(mnemonic);
      expect(result.did).toBe(did);
      expect(result.privateKey).toBe(privateKey);
      expect(result.signer.did()).toBe(did);
    },
  );

  it('trims surrounding whitespace before hashing (same key either way)', async () => {
    const clean = await signerFromMnemonic(GOLDEN_VECTORS[0].mnemonic);
    const padded = await signerFromMnemonic(`  ${GOLDEN_VECTORS[0].mnemonic}\n`);
    expect(padded.did).toBe(clean.did);
    expect(padded.privateKey).toBe(clean.privateKey);
  });

  it('returns a privateKey that parseSigner round-trips to the same signer', async () => {
    const { did, privateKey } = await signerFromMnemonic(GOLDEN_VECTORS[0].mnemonic);
    const reparsed = parseSigner(privateKey);
    expect(reparsed.did()).toBe(did);
  });

  it('produces signatures that verify against the derived public key', async () => {
    const { signer, did } = await signerFromMnemonic(GOLDEN_VECTORS[0].mnemonic);
    const payload = new TextEncoder().encode('ucan-signer-round-trip');
    const signature = await signer.sign(payload);
    const verifier = ed25519.Verifier.parse(did as `did:key:${string}`);
    expect(await verifier.verify(payload, signature)).toBe(true);
  });

  it('withDID override keeps the same key but reports the supplied DID', async () => {
    const oracleDid = 'did:ixo:ixo1fyc0tfakzvup0p7q76apt9kky255h5vejajqkl' as const;
    const { signer, did, privateKey } = await signerFromMnemonic(
      GOLDEN_VECTORS[0].mnemonic,
      oracleDid,
    );
    expect(did).toBe(oracleDid);
    expect(signer.did()).toBe(oracleDid);
    // The underlying key is unchanged — the privateKey still parses to the base did:key.
    expect(privateKey).toBe(GOLDEN_VECTORS[0].privateKey);
  });
});

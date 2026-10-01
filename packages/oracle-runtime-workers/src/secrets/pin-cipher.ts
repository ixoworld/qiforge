/**
 * AES-256-CBC PIN cipher — the scheme the CLI uses when publishing the
 * oracle's P-256 private JWK into the Matrix account room, ported from the
 * chain-client's `decrypt()` (`setup-claim-signing-mnemonics.ts`):
 *
 *   - ciphertext format: `ivHex:cipherHex`
 *   - key: the UTF-8 bytes of `pin.padEnd(32)` (no KDF — parity, not choice)
 *   - padding: PKCS#7 (Node's `createDecipheriv` default; WebCrypto's
 *     AES-CBC removes it identically, so ciphertexts are interchangeable)
 *
 * Bare WebCrypto — runs on Workers and Node alike. Throws on a key that is
 * not exactly 32 bytes, mirroring Node's "Invalid key length" for over-long
 * or multi-byte PINs.
 */
import { hexToBytes } from '@noble/hashes/utils';

export async function decryptWithPin(
  text: string,
  pin: string,
): Promise<string> {
  const [ivHex, encryptedHex] = text.split(':');
  const iv = hexToBytes(ivHex ?? '');
  const encrypted = hexToBytes(encryptedHex ?? '');
  const keyBytes = new TextEncoder().encode(pin.padEnd(32));
  if (keyBytes.length !== 32) {
    throw new Error(
      `decryptWithPin: invalid key length ${keyBytes.length} (the PIN must be at most 32 single-byte characters)`,
    );
  }
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-CBC' },
    false,
    ['decrypt'],
  );
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv },
    key,
    encrypted,
  );
  return new TextDecoder().decode(plain);
}

/**
 * Where the Node runtime keeps the oracle's UCAN signing mnemonic, and how
 * to read it (`oracles-chain-client`'s `setup-claim-signing-mnemonics.ts`):
 * the account room's state event `ixo.room.state.secure` /
 * `encrypted_mnemonic_ed_signing` with content
 * `{ encrypted_mnemonic: 'ivHex:cipherHex' }`, AES-256-CBC under
 * `MATRIX_VALUE_PIN` (`decryptWithPin`). The Workers runtime only reads it —
 * provisioning stays with the Node runtime and the CLI.
 */

export const SIGNING_MNEMONIC_STATE_TYPE = 'ixo.room.state.secure';
export const SIGNING_MNEMONIC_STATE_KEY = 'encrypted_mnemonic_ed_signing';

/** The `encrypted_mnemonic` of a state-event content JSON, or null. */
export function encryptedMnemonicOf(contentJson: string): string | null {
  let content: unknown;
  try {
    content = JSON.parse(contentJson);
  } catch {
    return null;
  }
  if (typeof content !== 'object' || content === null) return null;
  const value = (content as { encrypted_mnemonic?: unknown })
    .encrypted_mnemonic;
  return typeof value === 'string' && /^[0-9a-f]+:[0-9a-f]+$/i.test(value)
    ? value
    : null;
}

const WORD_COUNTS = new Set([12, 15, 18, 21, 24]);

/**
 * A decrypted value that looks like a BIP-39 mnemonic (12–24 lowercase
 * words), normalised to single spaces — or null. A wrong PIN decrypts to
 * bytes that never pass this, which keeps garbage out of the signer.
 */
export function parseSigningMnemonic(plain: string): string | null {
  const words = plain.trim().split(/\s+/);
  if (!WORD_COUNTS.has(words.length)) return null;
  if (!words.every((w) => /^[a-z]+$/.test(w))) return null;
  return words.join(' ');
}

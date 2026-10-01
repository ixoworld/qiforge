import { describe, expect, it } from 'vitest';
import { decryptWithPin } from './pin-cipher';
import {
  encryptedMnemonicOf,
  parseSigningMnemonic,
  SIGNING_MNEMONIC_STATE_KEY,
  SIGNING_MNEMONIC_STATE_TYPE,
} from './signing-mnemonic';

/**
 * Produced by the Node runtime's cipher (`oracles-chain-client`
 * `setup-claim-signing-mnemonics.ts` `encrypt()`: AES-256-CBC, key =
 * `pin.padEnd(32)`, `ivHex:cipherHex`) for the BIP-39 test vector below under
 * PIN `123456`, with a fixed IV so the fixture is stable.
 */
const NODE_FIXTURE =
  '0102030405060708090a0b0c0d0e0f10:52878c13d38c1ccd23fd2dac8178be3b56bc5f4a1592e189e83ce09f55651219bbf9c009e874966b48b32ec6eb0a4e2f5adefb22abe3fa5e6521cdb4bdb79eb7dd4e9948b27acda280b3d39cbd899ed525b9c263f88b2dc012e3c3f215d8574e';
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PIN = '123456';

describe('the account-room signing mnemonic (Node runtime storage)', () => {
  it('names the state event the Node runtime writes', () => {
    expect(SIGNING_MNEMONIC_STATE_TYPE).toBe('ixo.room.state.secure');
    expect(SIGNING_MNEMONIC_STATE_KEY).toBe('encrypted_mnemonic_ed_signing');
  });

  it('decrypts a Node-produced ciphertext with the PIN and parses the mnemonic', async () => {
    const encrypted = encryptedMnemonicOf(
      JSON.stringify({ encrypted_mnemonic: NODE_FIXTURE }),
    );
    expect(encrypted).toBe(NODE_FIXTURE);
    const plain = await decryptWithPin(encrypted!, PIN);
    expect(parseSigningMnemonic(plain)).toBe(MNEMONIC);
  });

  it('rejects a wrong PIN instead of seating garbage', async () => {
    let plain: string | null = null;
    try {
      plain = await decryptWithPin(NODE_FIXTURE, '654321');
    } catch {
      // WebCrypto reports the padding error — also a rejection.
    }
    expect(plain === null ? null : parseSigningMnemonic(plain)).toBeNull();
  });

  it('ignores content without a well-formed encrypted_mnemonic', () => {
    expect(encryptedMnemonicOf('{}')).toBeNull();
    expect(encryptedMnemonicOf('not json')).toBeNull();
    expect(
      encryptedMnemonicOf(JSON.stringify({ encrypted_mnemonic: 42 })),
    ).toBeNull();
    expect(
      encryptedMnemonicOf(JSON.stringify({ encrypted_mnemonic: 'no-colon' })),
    ).toBeNull();
  });

  it('accepts only 12–24 lowercase words, normalising whitespace', () => {
    expect(parseSigningMnemonic(`  ${MNEMONIC.replace(/ /g, '   ')}\n`)).toBe(
      MNEMONIC,
    );
    expect(parseSigningMnemonic('abandon about')).toBeNull();
    expect(parseSigningMnemonic(MNEMONIC.replace('about', 'About'))).toBeNull();
    expect(parseSigningMnemonic(MNEMONIC + ' extra')).toBeNull();
  });
});

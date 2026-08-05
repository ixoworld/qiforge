import { createCipheriv, randomBytes } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  decrypt,
  encrypt,
  isLegacyCiphertext,
  isWeakPassword,
  MIN_RECOMMENDED_PASSWORD_LENGTH,
  rewrap,
  secretEquals,
} from './secret-box.js';

const PASSPHRASE = 'correct horse battery staple';
const MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

/** The scheme this module replaces, reproduced so compatibility is actually tested. */
function legacyEncrypt(text: string, password: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv(
    'aes-256-cbc',
    Buffer.from(password.padEnd(32)),
    iv,
  );
  const out = Buffer.concat([cipher.update(text), cipher.final()]);
  return `${iv.toString('hex')}:${out.toString('hex')}`;
}

describe('encrypt / decrypt', () => {
  it('round-trips', () => {
    expect(decrypt(encrypt(MNEMONIC, PASSPHRASE), PASSPHRASE)).toBe(MNEMONIC);
  });

  it('round-trips unicode and empty input', () => {
    for (const value of ['', '🔐 ключ 密鑰', 'a'.repeat(4096)]) {
      expect(decrypt(encrypt(value, PASSPHRASE), PASSPHRASE)).toBe(value);
    }
  });

  it('writes the versioned format', () => {
    const parts = encrypt(MNEMONIC, PASSPHRASE).split(':');
    expect(parts[0]).toBe('v2');
    expect(parts).toHaveLength(5);
  });

  it('never writes the legacy format', () => {
    expect(isLegacyCiphertext(encrypt(MNEMONIC, PASSPHRASE))).toBe(false);
  });

  it('salts every write, so identical plaintexts differ', () => {
    const a = encrypt(MNEMONIC, PASSPHRASE);
    const b = encrypt(MNEMONIC, PASSPHRASE);
    expect(a).not.toBe(b);
    // Salt and IV both differ; neither ciphertext leaks equality of plaintext.
    expect(a.split(':')[1]).not.toBe(b.split(':')[1]);
    expect(a.split(':')[4]).not.toBe(b.split(':')[4]);
    expect(decrypt(a, PASSPHRASE)).toBe(decrypt(b, PASSPHRASE));
  });

  it('rejects the wrong passphrase', () => {
    expect(() => decrypt(encrypt(MNEMONIC, PASSPHRASE), 'wrong')).toThrow(
      /wrong passphrase|altered/i,
    );
  });

  it('detects tampering with the ciphertext', () => {
    const parts = encrypt(MNEMONIC, PASSPHRASE).split(':');
    const body = Buffer.from(parts[4] as string, 'hex');
    body[0] ^= 0xff;
    parts[4] = body.toString('hex');
    expect(() => decrypt(parts.join(':'), PASSPHRASE)).toThrow(/altered/i);
  });

  it('detects tampering with the authentication tag', () => {
    const parts = encrypt(MNEMONIC, PASSPHRASE).split(':');
    const tag = Buffer.from(parts[3] as string, 'hex');
    tag[0] ^= 0xff;
    parts[3] = tag.toString('hex');
    expect(() => decrypt(parts.join(':'), PASSPHRASE)).toThrow(/altered/i);
  });

  it('detects a swapped salt', () => {
    const other = encrypt(MNEMONIC, PASSPHRASE).split(':');
    const parts = encrypt(MNEMONIC, PASSPHRASE).split(':');
    parts[1] = other[1] as string;
    expect(() => decrypt(parts.join(':'), PASSPHRASE)).toThrow(/altered/i);
  });

  it('rejects a malformed versioned ciphertext', () => {
    expect(() => decrypt('v2:aa:bb', PASSPHRASE)).toThrow(/malformed/i);
  });

  it('rejects a tag of the wrong size', () => {
    const parts = encrypt(MNEMONIC, PASSPHRASE).split(':');
    parts[3] = 'aabb';
    expect(() => decrypt(parts.join(':'), PASSPHRASE)).toThrow(
      /authentication tag/i,
    );
  });
});

describe('legacy compatibility', () => {
  it('still reads ciphertext written by the old scheme', () => {
    const pin = 'old-pin-1234';
    expect(decrypt(legacyEncrypt(MNEMONIC, pin), pin)).toBe(MNEMONIC);
  });

  it('recognises which scheme a ciphertext used', () => {
    expect(isLegacyCiphertext(legacyEncrypt(MNEMONIC, 'pin'))).toBe(true);
    expect(isLegacyCiphertext(encrypt(MNEMONIC, PASSPHRASE))).toBe(false);
  });

  it('rejects a malformed legacy ciphertext', () => {
    expect(() => decrypt('deadbeef', 'pin')).toThrow(/malformed legacy/i);
  });
});

describe('rewrap', () => {
  it('upgrades a legacy ciphertext in place, preserving the plaintext', () => {
    const pin = 'old-pin-1234';
    const legacy = legacyEncrypt(MNEMONIC, pin);
    const upgraded = rewrap(legacy, pin);
    expect(upgraded).not.toBeNull();
    expect(isLegacyCiphertext(upgraded as string)).toBe(false);
    expect(decrypt(upgraded as string, pin)).toBe(MNEMONIC);
  });

  it('reports nothing to do for a current ciphertext', () => {
    expect(rewrap(encrypt(MNEMONIC, PASSPHRASE), PASSPHRASE)).toBeNull();
  });
});

describe('operator guidance', () => {
  it('flags a passphrase short enough that a KDF only delays an attacker', () => {
    expect(isWeakPassword('1234')).toBe(true);
    expect(isWeakPassword('   short   ')).toBe(true);
    expect(isWeakPassword('x'.repeat(MIN_RECOMMENDED_PASSWORD_LENGTH))).toBe(
      false,
    );
  });
});

describe('secretEquals', () => {
  it('compares without leaking length-independent timing', () => {
    expect(secretEquals('abc', 'abc')).toBe(true);
    expect(secretEquals('abc', 'abd')).toBe(false);
    expect(secretEquals('abc', 'abcd')).toBe(false);
  });
});

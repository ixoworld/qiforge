/**
 * @fileoverview Authenticated encryption for the oracle's secret material at
 * rest in Matrix room state.
 *
 * This protects the entity's Ed25519 signing mnemonic and its P-256 secrets
 * key — the two artifacts that between them constitute the oracle's identity
 * and its ability to read every user secret. The threat is an attacker who has
 * obtained the ciphertext (anyone able to read the account room's state) and
 * is working offline against it.
 *
 * ## Format
 *
 * Ciphertexts are versioned so the reader can distinguish schemes:
 *
 *   v2:<saltHex>:<ivHex>:<tagHex>:<cipherHex>     scrypt + AES-256-GCM
 *   <ivHex>:<cipherHex>                            legacy, read-only
 *
 * The legacy scheme derived nothing: it used the PIN space-padded to 32 bytes
 * directly as the AES key, in CBC mode with no authentication tag. A short
 * operator PIN was therefore the key itself, brute-forceable offline, and the
 * ciphertext was malleable. It is still *readable* here so existing
 * deployments keep working, but nothing writes it any more.
 *
 * ## Rollout order matters
 *
 * The CLI writes this material and the runtime reads it, so **deploy the
 * reader before the writer**. A runtime that predates v2 cannot read what a v2
 * CLI produces; the reverse (new runtime, old CLI) is handled by the legacy
 * read path.
 *
 * ## What this does not fix
 *
 * A KDF raises the cost of guessing a weak PIN; it does not make one strong.
 * `isWeakPassword` exists so callers can warn operators. Re-wrapping existing
 * legacy ciphertext is a separate migration — see `isLegacyCiphertext`.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'crypto';

/** Marks a ciphertext written by the current scheme. */
const V2_PREFIX = 'v2';

const SALT_BYTES = 16;
/** 96 bits — the size GCM is specified around. */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * scrypt cost parameters. `N` dominates: 128 * N * r bytes of memory, so
 * these settle at 32 MiB per derivation — enough to make offline guessing
 * expensive without making a boot-time unwrap noticeable.
 *
 * `maxmem` is raised explicitly because Node's 32 MiB default is exactly the
 * requirement here and the call would otherwise fail.
 */
const SCRYPT_PARAMS = {
  N: 32_768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
} as const;

/**
 * Below this, a passphrase is short enough that a KDF only delays an offline
 * attacker rather than defeating one.
 */
export const MIN_RECOMMENDED_PASSWORD_LENGTH = 16;

/** True when the passphrase is too short to rely on. Callers should warn. */
export function isWeakPassword(password: string): boolean {
  return password.trim().length < MIN_RECOMMENDED_PASSWORD_LENGTH;
}

/** True when the ciphertext predates authenticated encryption and should be re-wrapped. */
export function isLegacyCiphertext(text: string): boolean {
  return !text.startsWith(`${V2_PREFIX}:`);
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, KEY_BYTES, SCRYPT_PARAMS);
}

/**
 * Encrypts with a freshly salted key and an authentication tag.
 *
 * Always writes the current scheme; the legacy format is never produced.
 */
export function encrypt(text: string, password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(password, salt), iv);
  const ciphertext = Buffer.concat([
    cipher.update(text, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    V2_PREFIX,
    salt.toString('hex'),
    iv.toString('hex'),
    tag.toString('hex'),
    ciphertext.toString('hex'),
  ].join(':');
}

/**
 * Decrypts either scheme.
 *
 * Throws when the ciphertext is malformed, the passphrase is wrong, or — for
 * the current scheme — the ciphertext has been tampered with. The legacy
 * scheme cannot detect tampering; that is why it is being retired.
 */
export function decrypt(text: string, password: string): string {
  return isLegacyCiphertext(text)
    ? decryptLegacy(text, password)
    : decryptV2(text, password);
}

function decryptV2(text: string, password: string): string {
  const parts = text.split(':');
  const [, saltHex, ivHex, tagHex, cipherHex] = parts;
  // `cipherHex` is legitimately empty when the plaintext was empty — GCM still
  // produces a tag over it — so the check is on structure, not truthiness.
  if (
    parts.length !== 5 ||
    !saltHex ||
    !ivHex ||
    !tagHex ||
    cipherHex === undefined
  ) {
    throw new Error(
      'Malformed ciphertext: expected v2:<salt>:<iv>:<tag>:<ciphertext>.',
    );
  }

  const tag = Buffer.from(tagHex, 'hex');
  if (tag.length !== TAG_BYTES) {
    throw new Error('Malformed ciphertext: authentication tag has wrong size.');
  }

  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey(password, Buffer.from(saltHex, 'hex')),
    Buffer.from(ivHex, 'hex'),
  );
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(cipherHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // GCM fails closed on a wrong key or altered ciphertext, and the two are
    // deliberately indistinguishable to the caller.
    throw new Error(
      'Decryption failed: wrong passphrase, or the ciphertext was altered.',
    );
  }
}

function decryptLegacy(text: string, password: string): string {
  const [ivHex, encryptedHex] = text.split(':');
  if (!ivHex || !encryptedHex) {
    throw new Error('Malformed legacy ciphertext: expected <iv>:<ciphertext>.');
  }
  const decipher = createDecipheriv(
    'aes-256-cbc',
    Buffer.from(password.padEnd(32)),
    Buffer.from(ivHex, 'hex'),
  );
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Re-wraps a ciphertext under the current scheme.
 *
 * Returns `null` when the input is already current, so a caller can persist
 * only when there is something to persist.
 */
export function rewrap(text: string, password: string): string | null {
  if (!isLegacyCiphertext(text)) return null;
  return encrypt(decrypt(text, password), password);
}

/** Constant-time equality, for callers comparing secret-derived values. */
export function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

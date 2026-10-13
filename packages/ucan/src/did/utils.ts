// =============================================================================
// Base58 Encoding/Decoding (Bitcoin alphabet)
// =============================================================================

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// Create lookup table for faster decoding
const BASE58_MAP: Record<string, number> = {};
for (let i = 0; i < BASE58_ALPHABET.length; i++) {
  BASE58_MAP[BASE58_ALPHABET[i]!] = i;
}

/**
 * Decode a Base58-encoded string to bytes
 *
 * Algorithm: Treat input as base-58 number, convert to base-256
 */
export function base58Decode(str: string): Uint8Array {
  if (str.length === 0) {
    return new Uint8Array(0);
  }

  // Count leading '1's (which represent leading zero bytes)
  let leadingZeros = 0;
  for (const char of str) {
    if (char === '1') {
      leadingZeros++;
    } else {
      break;
    }
  }

  // Allocate enough space for the result
  // Base58 uses ~5.86 bits per character, so we need at most ceil(len * log(58) / log(256)) bytes
  const size = Math.ceil((str.length * Math.log(58)) / Math.log(256));
  const bytes = new Uint8Array(size);

  // Process each character
  for (const char of str) {
    const value = BASE58_MAP[char];
    if (value === undefined) {
      throw new Error(`Invalid Base58 character: ${char}`);
    }

    // Multiply existing bytes by 58 and add the new value
    let carry = value;
    for (let i = size - 1; i >= 0; i--) {
      const current = bytes[i]! * 58 + carry;
      bytes[i] = current % 256;
      carry = Math.floor(current / 256);
    }
  }

  // Find where the actual data starts (skip leading zeros in result)
  let start = 0;
  while (start < bytes.length && bytes[start] === 0) {
    start++;
  }

  // Combine leading zero bytes with the decoded data
  const result = new Uint8Array(leadingZeros + (bytes.length - start));
  // Leading zeros are already 0 in a new Uint8Array
  result.set(bytes.subarray(start), leadingZeros);

  return result;
}

/**
 * Encode bytes to Base58 string
 *
 * Algorithm: Treat input as base-256 number, convert to base-58
 */
export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return '';
  }

  // Count leading zeros
  let leadingZeros = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      leadingZeros++;
    } else {
      break;
    }
  }

  // Allocate enough space for the result
  // We need at most ceil(len * log(256) / log(58)) digits
  const size = Math.ceil((bytes.length * Math.log(256)) / Math.log(58));
  const digits = new Uint8Array(size);

  // Process each byte
  for (const byte of bytes) {
    let carry = byte;
    for (let i = size - 1; i >= 0; i--) {
      const current = digits[i]! * 256 + carry;
      digits[i] = current % 58;
      carry = Math.floor(current / 58);
    }
  }

  // Find where the actual data starts
  let start = 0;
  while (start < digits.length && digits[start] === 0) {
    start++;
  }

  // Build result string
  let result = '1'.repeat(leadingZeros);
  for (let i = start; i < digits.length; i++) {
    result += BASE58_ALPHABET[digits[i]!];
  }

  return result;
}

// =============================================================================
// Ed25519 did:key
// =============================================================================

/**
 * Convert a `publicKeyMultibase` value to a did:key, only when it is an
 * Ed25519 multicodec key: base58btc (`z`) over the varint code 0xed
 * (`0xed 0x01`) followed by exactly 32 key bytes. Any other value — another
 * key type, a raw key without the multicodec prefix, another multibase
 * encoding, malformed base58 — yields null, so callers can skip that
 * verification method instead of handing an unusable key to the verifier.
 */
export function ed25519MultibaseToDidKey(
  multibase: string,
): `did:key:${string}` | null {
  if (!multibase.startsWith('z')) return null;
  let bytes: Uint8Array;
  try {
    bytes = base58Decode(multibase.slice(1));
  } catch {
    return null;
  }
  if (bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) {
    return null;
  }
  return `did:key:${multibase}`;
}

// =============================================================================
// Hex Encoding/Decoding
// =============================================================================

/**
 * Decode a hex string to bytes
 */
export function hexDecode(hex: string): Uint8Array {
  // Remove optional 0x prefix
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;

  if (cleanHex.length % 2 !== 0) {
    throw new Error('Invalid hex string: odd length');
  }

  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16);
  }

  return bytes;
}

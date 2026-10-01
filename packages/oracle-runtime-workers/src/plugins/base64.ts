/**
 * Base64 helpers over the Web platform primitives (`btoa`/`atob`) — the
 * Workers runtime has no `Buffer`. Chunked so multi-megabyte payloads never
 * hit the argument-count limit of `String.fromCharCode(...bytes)`.
 */

const CHUNK = 0x8000;

/** Encode raw bytes as standard base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Decode standard base64 to raw bytes. Throws on malformed input. */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

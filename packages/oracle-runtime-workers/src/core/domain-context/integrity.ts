/**
 * Byte-level checks every domain document passes before anything reads it:
 * the anchor's CID must name the exact bytes, and the bytes must be strict
 * UTF-8 without a byte-order mark.
 */
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';

/** multicodec `raw`. */
const RAW_CODEC = 0x55;
/** multihash `sha2-256`. */
const SHA2_256 = 0x12;

/** Index (`domain.md`) and capsule manifest bound. */
export const INDEX_MAX_BYTES = 1024 * 1024;
/** Linked document bound. */
export const LINKED_DOCUMENT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Throws unless `cid` is a CIDv1 over the raw codec with a sha2-256 digest of
 * exactly `bytes`. Any other CID shape is refused rather than interpreted.
 */
export async function verifyBytes(
  bytes: Uint8Array,
  cid: string,
): Promise<void> {
  let expected: CID;
  try {
    expected = CID.parse(cid);
  } catch {
    throw new Error('invalid-cid');
  }
  if (
    expected.version !== 1 ||
    expected.code !== RAW_CODEC ||
    expected.multihash.code !== SHA2_256
  )
    throw new Error('unsupported-cid-codec');
  const digest = await sha256.digest(bytes);
  if (!CID.createV1(RAW_CODEC, digest).equals(expected))
    throw new Error('cid-mismatch');
}

/** CIDv1 (raw, sha2-256) of `bytes`, as its default base32 string. */
export async function cidOf(bytes: Uint8Array): Promise<string> {
  return CID.createV1(RAW_CODEC, await sha256.digest(bytes)).toString();
}

/** Strict UTF-8 decode; a byte-order mark or any invalid sequence is refused. */
export function decode(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    throw new Error('utf8-bom');
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new Error('invalid-utf8');
  }
}

/**
 * Whether an IID document lets an account act for its DID, read the way the
 * chain reads it (ixo-blockchain `x/iid/types/iid.go`,
 * `IidDocument.HasRelationship`): a verification method that is the account
 * — its `blockchainAccountID`, or a secp256k1 key whose address is the
 * account — named under one of the relationships the message needs.
 *
 * Shared by the POD Creator (the owner must be able to sign for their own
 * DID: `authentication` or `assertionMethod`, the ante handler's check) and
 * `link_dao_group` (the user must be able to change an entity's identity:
 * `authentication`, the IID message server's check).
 */
import { sha256 } from '@noble/hashes/sha2';
import { ripemd160 } from '@noble/hashes/legacy';
import { hexToBytes } from '@noble/hashes/utils';
import { base58btc } from 'multiformats/bases/base58';
import { z } from 'zod';

/** A verification method as chain REST answers it: the fields the check reads. */
export const verificationMethodSchema = z.object({
  id: z.string(),
  type: z.string(),
  blockchainAccountID: z.string().optional(),
  publicKeyHex: z.string().optional(),
  publicKeyMultibase: z.string().optional(),
  publicKeyBase58: z.string().optional(),
});

export type VerificationMethod = z.infer<typeof verificationMethodSchema>;

/** A verification relationship the chain checks a signer under. */
export type SignerRelationship = 'authentication' | 'assertionMethod';

/** The parts of an IID document the check reads. */
export type IidSignerDocument = {
  verificationMethod: readonly VerificationMethod[];
} & Record<SignerRelationship, readonly string[]>;

/** Bytes of an even-length hex string; null for anything else. */
export function hexBytes(text: string): Uint8Array | null {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(text)) return null;
  return hexToBytes(text.toLowerCase());
}

function base58Bytes(text: string): Uint8Array | null {
  try {
    return base58btc.baseDecode(text);
  } catch {
    return null;
  }
}

/**
 * A verification method's key bytes, read the way the chain reads them when
 * it checks a signer (`IidDocument.HasRelationship`): `publicKeyMultibase`
 * as hex after its one-character prefix (the Portal writes `F` + hex),
 * `publicKeyHex` as hex, `publicKeyBase58` as base58. Null when there is no
 * key or it does not decode.
 */
export function methodKey(method: VerificationMethod): Uint8Array | null {
  if (method.publicKeyMultibase !== undefined)
    return hexBytes(method.publicKeyMultibase.slice(1));
  if (method.publicKeyHex !== undefined) return hexBytes(method.publicKeyHex);
  if (method.publicKeyBase58 !== undefined)
    return base58Bytes(method.publicKeyBase58);
  return null;
}

export const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

/**
 * The account a 33-byte key stands for: RIPEMD-160 of its SHA-256, as the
 * chain derives a secp256k1 key's address. Null for any other length.
 */
export function keyAccount(key: Uint8Array): Uint8Array | null {
  return key.length === 33 ? ripemd160(sha256(key)) : null;
}

/** Whether the chain counts `method` as the account `address` (`HasRelationship`'s material match). */
export function methodIsAccount(
  method: VerificationMethod,
  address: string,
  accountBytes: Uint8Array,
): boolean {
  if (method.blockchainAccountID !== undefined)
    return method.blockchainAccountID === address;
  const key = methodKey(method);
  const account = key ? keyAccount(key) : null;
  return account !== null && sameBytes(account, accountBytes);
}

/**
 * Whether `doc` names a verification method of the account `address`
 * (`accountBytes`: its 20 bytes) under one of `relationships`.
 */
export function listsAccountUnder(
  doc: IidSignerDocument,
  address: string,
  accountBytes: Uint8Array,
  relationships: readonly SignerRelationship[],
): boolean {
  const named = new Set(
    relationships.flatMap((relationship) => doc[relationship]),
  );
  return doc.verificationMethod.some(
    (method) =>
      named.has(method.id) && methodIsAccount(method, address, accountBytes),
  );
}

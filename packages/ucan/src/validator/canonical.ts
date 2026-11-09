/**
 * @fileoverview Canonical form of the UCANs in a CAR archive
 *
 * A token is a CAR archive of blocks, each stored under a CID the SENDER
 * writes. ucanto's `Delegation.extract` takes those CIDs as written (block
 * bytes are not re-hashed), and dag-ucan verifies a signature over the
 * payload re-formatted from the decoded fields, not over the block bytes. So
 * one signed UCAN can travel under many CIDs: another multihash or CID version
 * over the same bytes, its JWT representation (raw codec), a JWT whose JSON is
 * spelled differently but parses to the same fields, or a dag-cbor block with
 * a field the signed JSON leaves out (`nnc: ""`). Every check keyed on a CID
 * (single use, revocation) could then be dodged with the same signature.
 *
 * The validator therefore requires every embedded UCAN to sit under the CID
 * derived from its signed form alone (dag-cbor, sha2-256, CIDv1). After that
 * check a CID is a function of what the signature covers, so the replay store
 * and the revocation checker can keep working on CIDs.
 */

import { UCAN } from '@ucanto/core';

/**
 * The string a UCAN's signature verifies: `header.payload.signature`, rebuilt
 * from its decoded fields. Throws when the UCAN arrived as a JWT spelled
 * differently from that form (dag-ucan then keeps the sender's spelling,
 * which the signature does not cover).
 */
export function signedForm(data: UCAN.View): string {
  const jwt = UCAN.format(data);
  if (UCAN.parse(jwt).jwt !== undefined) {
    throw new Error('UCAN is not in canonical form');
  }
  return jwt;
}

/**
 * The canonical CID of a UCAN: dag-cbor, sha2-256, CIDv1, derived from its
 * signed form only.
 */
export async function canonicalCid(data: UCAN.View): Promise<string> {
  return (await UCAN.link(UCAN.parse(signedForm(data)))).toString();
}

/** The parts of an extracted ucanto delegation (or proof link) read here. */
interface UcanNode {
  cid?: unknown;
  data?: UCAN.View;
  proofs?: unknown[];
}

function asUcanNode(node: unknown): UcanNode | null {
  return typeof node === 'object' && node !== null ? node : null;
}

/**
 * Every UCAN embedded in the archive (the root and every embedded proof, each
 * once) must sit under its canonical CID. Returns a reason when one does not,
 * else null. A proof that is only a link (its block is not in the archive)
 * carries no UCAN to compare; the chain verification fails it anyway. Callers
 * run this after the proof tree's shape has been bounded.
 */
export async function nonCanonicalBlock(root: unknown): Promise<string | null> {
  const seen = new Set<string>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = asUcanNode(stack.pop());
    if (!node || node.data === undefined) continue;
    if (node.cid === undefined || node.cid === null) {
      return 'A UCAN block has no CID';
    }
    const stated = String(node.cid);
    if (seen.has(stated)) continue;
    seen.add(stated);
    let canonical: string;
    try {
      canonical = await canonicalCid(node.data);
    } catch {
      return 'A UCAN block is not in canonical form';
    }
    if (stated !== canonical) {
      return 'A UCAN block does not carry its canonical CID';
    }
    for (const proof of node.proofs ?? []) stack.push(proof);
  }
  return null;
}

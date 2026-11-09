/**
 * A UCAN archive's CIDs are written by its sender and no signature covers
 * them, so the same signed invocation or delegation can be re-sent under
 * another CID (here: CIDv1 over a sha2-512 digest of the same bytes). The
 * shell must refuse such a token, so a re-labelled delegation is never
 * deposited or forwarded and a CID downstream services key replay and
 * revocation on is always the canonical one.
 */
import {
  createDelegation,
  createInvocation,
  generateKeypair,
  serializeDelegation,
  serializeInvocation,
  UcantoServer,
} from '@ixo/ucan';
import { describe, expect, it } from 'vitest';
import { authenticate } from './auth';

const { CAR, CBOR, UCAN, createLink, decodeLink, isLink, sha256 } =
  UcantoServer;

type Block = Awaited<ReturnType<typeof UCAN.write>>;
type BlockCid = Block['cid'];

const ORACLE_DID = (await generateKeypair()).did;
const CFG = {
  oracleDid: ORACLE_DID,
  blocksyncUri: 'https://blocksync.invalid/graphql',
};
const nowSeconds = () => Math.floor(Date.now() / 1000);

const fromB64 = (b64: string) =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** The archive's UCAN block (the variant root `{ "ucan@0.9.1": link }` points at it). */
function openArchive(token: string) {
  const { roots, blocks } = CAR.decode(fromB64(token));
  const root = roots[0];
  if (!root) throw new Error('archive has no root');
  const variant: unknown = CBOR.decode(root.bytes);
  if (typeof variant !== 'object' || variant === null)
    throw new Error('archive root is not a variant');
  const [entry] = Object.entries(variant);
  if (!entry || !isLink(entry[1])) throw new Error('variant holds no link');
  const [key, link] = entry;
  const block = blocks.get(link.toString());
  if (!block) throw new Error('archive has no UCAN block');
  return { root, blocks, key, link, bytes: block.bytes };
}

/** The same archive with its UCAN block stored under a sha2-512 CID of the same bytes. */
async function relabelSha512(token: string): Promise<string> {
  const { root, blocks, key, link, bytes } = openArchive(token);
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-512', new Uint8Array(bytes)),
  );
  const cid: BlockCid = decodeLink(
    new Uint8Array([0x01, link.code, 0x13, 0x40, ...digest]),
  );
  const out = new Map(blocks);
  out.delete(link.toString());
  out.delete(root.cid.toString());
  out.set(cid.toString(), { cid, bytes });
  const variantBytes = CBOR.encode({ [key]: cid });
  const rootCid = createLink(CBOR.code, await sha256.digest(variantBytes));
  return toB64(
    CAR.encode({
      roots: [{ cid: rootCid, bytes: variantBytes }],
      blocks: out,
    }),
  );
}

async function invocation(issuer: Awaited<ReturnType<typeof generateKeypair>>) {
  return serializeInvocation(
    await createInvocation({
      issuer: issuer.signer,
      audience: ORACLE_DID,
      capability: { can: '*', with: 'ixo:oracle' },
      proofs: [],
      expiration: nowSeconds() + 300,
    }),
  );
}

async function delegation(issuer: Awaited<ReturnType<typeof generateKeypair>>) {
  return serializeDelegation(
    await createDelegation({
      issuer: issuer.signer,
      audience: ORACLE_DID,
      capabilities: [{ can: '*', with: 'ixo:oracle' }],
      expiration: nowSeconds() + 3600,
    }),
  );
}

const ucan = (token: string, extra: Record<string, string> = {}) =>
  new Headers({
    authorization: `Bearer ${token}`,
    'x-auth-type': 'ucan',
    ...extra,
  });

describe('authenticate: a token re-labelled under another CID', () => {
  it('refuses a re-labelled invocation that is valid under its own CID', async () => {
    const user = await generateKeypair();
    const token = await invocation(user);
    expect(await authenticate(ucan(token), CFG)).toMatchObject({
      ok: true,
      auth: { userDid: user.did },
    });
    const outcome = await authenticate(ucan(await relabelSha512(token)), CFG);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(401);
    expect(outcome.error).toMatch(
      /^Invalid UCAN invocation: \[INVALID_FORMAT\]/,
    );
  });

  it('never carries a re-labelled delegation downstream beside a valid invocation', async () => {
    const user = await generateKeypair();
    const token = await invocation(user);
    const grant = await delegation(user);
    const canonical = await authenticate(
      ucan(token, { 'x-ucan-delegation': grant }),
      CFG,
    );
    expect(canonical.ok && canonical.auth.delegation).toBe(grant);
    const relabelled = await authenticate(
      ucan(token, { 'x-ucan-delegation': await relabelSha512(grant) }),
      CFG,
    );
    expect(relabelled).toMatchObject({
      ok: true,
      auth: { userDid: user.did, via: 'invocation' },
    });
    if (!relabelled.ok) return;
    expect(relabelled.auth.delegation).toBeUndefined();
  });

  it('refuses a re-labelled bare delegation even with the legacy fallback on', async () => {
    const user = await generateKeypair();
    const outcome = await authenticate(
      new Headers({
        'x-ucan-delegation': await relabelSha512(await delegation(user)),
      }),
      { ...CFG, allowBareDelegation: true },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toMatch(
      /^Invalid UCAN delegation: \[INVALID_FORMAT\]/,
    );
  });
});

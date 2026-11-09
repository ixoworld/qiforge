import { beforeAll, describe, expect, it } from 'vitest';
import * as Client from '@ucanto/client';
import { ed25519 } from '@ucanto/principal';
import {
  CAR,
  CBOR,
  Delegation,
  UCAN,
  createLink,
  decodeLink,
  isLink,
  sha256,
} from '@ucanto/core';
import { createUCANValidator } from './validator.js';
import { canonicalCid } from './canonical.js';
import { defineCapability } from '../capabilities/capability.js';
import {
  getDelegationCid,
  serializeDelegation,
  serializeInvocation,
} from '../client/create-client.js';
import { InMemoryInvocationStore } from '../store/memory.js';
import type { UCANBlock } from '@ucanto/interface';

/**
 * The CIDs in a CAR archive are written by its sender and covered by no
 * signature, and dag-ucan verifies a signature over the payload re-formatted
 * from the decoded fields. These tests re-wrap one signed UCAN under other
 * CIDs and check that neither the replay store nor the revocation checker can
 * be dodged that way.
 */

const RAW_CODE = 0x55;
const TestRead = defineCapability({ can: 'test/read', protocol: 'ixo:' });
const RESOURCE = 'ixo:resource:1';

type Block = UCANBlock;
type BlockCid = Block['cid'];

const fromB64 = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));
const toB64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

/** The archive's UCAN block (the variant root `{ "ucan@0.9.1": link }` points at it). */
function openArchive(token: string) {
  const { roots, blocks } = CAR.decode(fromB64(token));
  const root = roots[0];
  if (!root) throw new Error('archive has no root');
  const variant: unknown = CBOR.decode(root.bytes);
  if (typeof variant !== 'object' || variant === null) {
    throw new Error('archive root is not a variant');
  }
  const [entry] = Object.entries(variant);
  if (!entry || !isLink(entry[1])) throw new Error('variant holds no link');
  const [key, link] = entry;
  const block = blocks.get(link.toString());
  if (!block) throw new Error('archive has no UCAN block');
  return { root, blocks, key, link, bytes: block.bytes };
}

/** The archive's UCAN as a typed block (re-encoded; a client's block is already canonical). */
function ucanBlock(token: string): Promise<Block> {
  return UCAN.write(UCAN.decode(openArchive(token).bytes));
}

/** The same archive with its UCAN block stored under `next`. */
async function rewrap(token: string, next: Block): Promise<string> {
  const { root, blocks, key, link } = openArchive(token);
  const out = new Map(blocks);
  out.delete(link.toString());
  out.delete(root.cid.toString());
  out.set(next.cid.toString(), next);
  const variantBytes = CBOR.encode({ [key]: next.cid });
  const rootCid = createLink(CBOR.code, await sha256.digest(variantBytes));
  return toB64(
    CAR.encode({
      roots: [{ cid: rootCid, bytes: variantBytes }],
      blocks: out,
    }),
  );
}

/** Same bytes, new CID: CIDv1(same codec, sha2-512 of the SAME bytes). */
async function sha512Label(block: Block): Promise<Block> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-512', new Uint8Array(block.bytes)),
  );
  const cid: BlockCid = decodeLink(
    new Uint8Array([0x01, block.cid.code, 0x13, 0x40, ...digest]),
  );
  return { cid, bytes: block.bytes };
}

/** The same signed UCAN as a JWT block (raw codec), optionally re-spelled. */
async function jwtForm(block: Block, respell = false): Promise<Block> {
  let jwt: string = UCAN.format(UCAN.decode(block.bytes));
  if (respell) {
    // Same header fields, other spelling: parses to the same UCAN, and the
    // signature still verifies (it covers the RE-FORMATTED payload).
    const [header = '', payload = '', signature = ''] = jwt.split('.');
    const fields: Record<string, unknown> = JSON.parse(
      Buffer.from(header, 'base64url').toString(),
    );
    const spelled = `{ "alg": ${JSON.stringify(fields.alg)}, "typ": "JWT", "ucv": ${JSON.stringify(fields.ucv)} }`;
    jwt = `${b64url(Buffer.from(spelled))}.${payload}.${signature}`;
  }
  const bytes = new TextEncoder().encode(jwt);
  const cid: BlockCid = createLink(RAW_CODE, await sha256.digest(bytes));
  return { cid, bytes };
}

/** dag-cbor with `nnc: ""`: the signed JSON omits an empty nonce, the CBOR keeps it. */
async function emptyNonce(block: Block): Promise<Block> {
  const view = UCAN.decode(block.bytes);
  const bytes = UCAN.encode({ ...view.model, nnc: '' });
  const cid: BlockCid = createLink(UCAN.code, await sha256.digest(bytes));
  return { cid, bytes };
}

const VARIANTS: Array<[string, (block: Block) => Promise<Block>]> = [
  ['a sha2-512 CID over the same bytes', sha512Label],
  ['its JWT representation', (b) => jwtForm(b)],
  ['a JWT whose header is spelled differently', (b) => jwtForm(b, true)],
  ['a dag-cbor block with an empty nonce', emptyNonce],
];

let server: Awaited<ReturnType<typeof ed25519.Signer.generate>>;
let user: Awaited<ReturnType<typeof ed25519.Signer.generate>>;

beforeAll(async () => {
  [server, user] = await Promise.all([
    ed25519.Signer.generate(),
    ed25519.Signer.generate(),
  ]);
});

function invocationToken(): Promise<string> {
  return serializeInvocation(
    Client.invoke({
      issuer: user,
      audience: ed25519.Verifier.parse(server.did()),
      capability: { can: 'test/read' as const, with: RESOURCE },
    }),
  );
}

describe('a used invocation re-labelled under another CID', () => {
  it('the canonical CID is the CID clients already produce', async () => {
    const token = await invocationToken();
    const { link, bytes } = openArchive(token);
    expect(await canonicalCid(UCAN.decode(bytes))).toBe(link.toString());
  });

  for (const [name, relabel] of VARIANTS) {
    it(`is refused when re-sent as ${name}`, async () => {
      const validator = await createUCANValidator({
        serverDid: server.did(),
        rootIssuers: ['*'],
        invocationStore: new InMemoryInvocationStore(),
      });
      const token = await invocationToken();
      expect((await validator.validate(token, TestRead, RESOURCE)).ok).toBe(
        true,
      );

      const copy = await rewrap(token, await relabel(await ucanBlock(token)));
      expect(copy).not.toBe(token);
      const replay = await validator.validate(copy, TestRead, RESOURCE);
      expect(replay.ok).toBe(false);
      expect(replay.error?.code).toBe('INVALID_FORMAT');
      expect(replay.error?.message).toMatch(/canonical/i);
    });
  }

  it('refuses a re-labelled copy presented first, without burning the original', async () => {
    const store = new InMemoryInvocationStore();
    const validator = await createUCANValidator({
      serverDid: server.did(),
      rootIssuers: ['*'],
      invocationStore: store,
    });
    const token = await invocationToken();
    const copy = await rewrap(token, await sha512Label(await ucanBlock(token)));
    expect((await validator.validate(copy, TestRead, RESOURCE)).ok).toBe(false);
    expect((await validator.validate(token, TestRead, RESOURCE)).ok).toBe(true);
    // The store holds the canonical CID, which is what clients compute.
    expect(await store.has(await getDelegationCid(token))).toBe(true);
  });
});

describe('a revoked delegation re-labelled under another CID', () => {
  async function revokedGrant() {
    const root = await ed25519.Signer.generate();
    const grant = await Client.delegate({
      issuer: root,
      audience: user,
      capabilities: [{ can: 'test/read' as const, with: RESOURCE }],
    });
    const revoked = new Set([grant.cid.toString()]);
    const validator = await createUCANValidator({
      serverDid: server.did(),
      rootIssuers: [root.did()],
      revocationChecker: {
        check: async (cids) => cids.filter((cid) => revoked.has(cid)),
      },
    });
    const grantBlock = { cid: grant.cid, bytes: grant.root.bytes };
    return { root, grant, grantBlock, validator };
  }

  it('baseline: the revoked delegation under its own CID is refused', async () => {
    const { grant, validator } = await revokedGrant();
    const token = await serializeInvocation(
      Client.invoke({
        issuer: user,
        audience: ed25519.Verifier.parse(server.did()),
        capability: { can: 'test/read' as const, with: RESOURCE },
        proofs: [grant],
      }),
    );
    const res = await validator.validate(token, TestRead, RESOURCE);
    expect(res.error?.code).toBe('REVOKED');
  });

  for (const [name, relabel] of VARIANTS) {
    it(`is refused inside a fresh invocation as ${name}`, async () => {
      const { grantBlock, validator } = await revokedGrant();
      const smuggled = Delegation.create({
        root: await relabel(grantBlock),
        blocks: new Map(),
      });
      const token = await serializeInvocation(
        Client.invoke({
          issuer: user,
          audience: ed25519.Verifier.parse(server.did()),
          capability: { can: 'test/read' as const, with: RESOURCE },
          proofs: [smuggled],
        }),
      );
      const res = await validator.validate(token, TestRead, RESOURCE);
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe('INVALID_FORMAT');
    });

    it(`is refused by validateDelegation as ${name}`, async () => {
      const { root, grantBlock } = await revokedGrant();
      // A delegation addressed to the server, revoked, then re-labelled.
      const toServer = await Client.delegate({
        issuer: root,
        audience: ed25519.Verifier.parse(server.did()),
        capabilities: [{ can: 'test/read' as const, with: RESOURCE }],
      });
      const revoked = new Set([
        toServer.cid.toString(),
        String(grantBlock.cid),
      ]);
      const validator = await createUCANValidator({
        serverDid: server.did(),
        rootIssuers: [root.did()],
        revocationChecker: {
          check: async (cids) => cids.filter((cid) => revoked.has(cid)),
        },
      });
      const token = await serializeDelegation(toServer);
      expect((await validator.validateDelegation(token)).error?.code).toBe(
        'REVOKED',
      );
      const copy = await rewrap(
        token,
        await relabel({ cid: toServer.cid, bytes: toServer.root.bytes }),
      );
      const res = await validator.validateDelegation(copy);
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe('INVALID_FORMAT');
    });
  }
});

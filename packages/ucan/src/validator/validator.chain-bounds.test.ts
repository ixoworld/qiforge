import { describe, expect, it } from 'vitest';
import * as Client from '@ucanto/client';
import { ed25519 } from '@ucanto/principal';
import {
  createUCANValidator,
  DEFAULT_MAX_ERROR_MESSAGE_CHARS,
  DEFAULT_PROOF_CHAIN_LIMITS,
  resourceNamesIssuer,
} from './validator.js';
import { defineCapability } from '../capabilities/capability.js';
import {
  serializeDelegation,
  serializeInvocation,
} from '../client/create-client.js';
import type { DIDKeyResolver, KeyDID } from '../types.js';

async function keygen() {
  const signer = await ed25519.Signer.generate();
  return { signer, did: signer.did() };
}

type Signer = Awaited<ReturnType<typeof keygen>>['signer'];

const TestRead = defineCapability({ can: 'test/read', protocol: 'ixo:' });
const TestWrite = defineCapability({ can: 'test/write', protocol: 'ixo:' });
const RESOURCE = 'ixo:resource:123' as const;

/** Resolver over a fixed DID -> did:key table that counts its calls. */
function countingResolver(table: Record<string, KeyDID[]>) {
  const calls: string[] = [];
  const resolver: DIDKeyResolver = async (did) => {
    calls.push(did);
    const keys = table[did];
    if (keys) return { ok: keys };
    return { error: { name: 'NotFound', did, message: 'Unknown DID' } };
  };
  return { resolver, calls };
}

async function grant(
  issuer: Signer,
  audience: Signer,
  proofs: Awaited<ReturnType<typeof Client.delegate>>[] = [],
  can: 'test/read' | 'test/write' = 'test/read',
  resource: `ixo:${string}` = RESOURCE,
) {
  return Client.delegate({
    issuer,
    audience,
    capabilities: [{ can, with: resource }],
    proofs,
  });
}

async function invoke(
  issuer: Parameters<typeof Client.invoke>[0]['issuer'],
  serverDid: string,
  proofs: Awaited<ReturnType<typeof Client.delegate>>[],
  can: 'test/read' | 'test/write' = 'test/read',
  resource: `ixo:${string}` = RESOURCE,
  nonce?: string,
) {
  return serializeInvocation(
    Client.invoke({
      issuer,
      audience: ed25519.Verifier.parse(serverDid),
      capability: { can, with: resource },
      proofs,
      nonce,
    }),
  );
}

/**
 * A linear chain root -> l1 -> ... -> invoker with `links` delegations, and
 * the invocation at the end.
 */
async function linearChain(serverDid: string, links: number) {
  const root = await keygen();
  let holder = root;
  let proof: Awaited<ReturnType<typeof Client.delegate>> | undefined;
  for (let i = 0; i < links; i++) {
    const next = await keygen();
    proof = await grant(holder.signer, next.signer, proof ? [proof] : []);
    holder = next;
  }
  return {
    root,
    invoker: holder,
    serialized: await invoke(holder.signer, serverDid, proof ? [proof] : []),
  };
}

describe('proof-chain shape limits', () => {
  it('exports generous defaults', () => {
    expect(DEFAULT_PROOF_CHAIN_LIMITS).toEqual({
      maxDepth: 10,
      maxNodes: 64,
      maxProofsPerLink: 16,
      maxCapabilitiesPerLink: 32,
      maxIssuers: 16,
      maxWork: 256,
    });
    expect(DEFAULT_MAX_ERROR_MESSAGE_CHARS).toBe(1024);
  });

  it('accepts a real 3-link chain and a link with 5 same-scope proofs under the defaults', async () => {
    const server = await keygen();
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: ['*'],
    });

    const chain = await linearChain(server.did, 3);
    const deep = await validator.validate(chain.serialized, TestRead, RESOURCE);
    expect(deep.ok).toBe(true);
    expect(deep.proofChain).toHaveLength(4);

    const owner = await keygen();
    const agent = await keygen();
    const proofs = [];
    for (let i = 0; i < 5; i++) {
      proofs.push(
        await Client.delegate({
          issuer: owner.signer,
          audience: agent.signer,
          capabilities: [{ can: 'test/read' as const, with: RESOURCE }],
          facts: [{ n: i }],
        }),
      );
    }
    const wide = await validator.validate(
      await invoke(agent.signer, server.did, proofs),
      TestRead,
      RESOURCE,
    );
    expect(wide.ok).toBe(true);
    expect(wide.proofChain).toEqual([owner.did, agent.did]);
  });

  it('refuses a small token whose proofs reuse the same blocks 3-wide at every level, fast and with a short message', async () => {
    const server = await keygen();
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: ['*'],
    });
    const owner = await keygen();
    const attacker = await keygen();

    // Each level references the SAME delegation three times: 3^depth visits
    // for a token that stays small because the CAR stores each block once.
    let level = await grant(owner.signer, attacker.signer);
    for (let i = 0; i < 6; i++) {
      level = await grant(attacker.signer, attacker.signer, [
        level,
        level,
        level,
      ]);
    }
    const serialized = await invoke(attacker.signer, server.did, [level]);
    expect(serialized.length).toBeLessThan(8_000);

    const started = Date.now();
    const result = await validator.validate(serialized, TestRead, RESOURCE);
    expect(Date.now() - started).toBeLessThan(500);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_FORMAT');
    expect(result.error?.message).toMatch(/Proof chain has more than 64 nodes/);
  });

  it('refuses a chain deeper than maxDepth and a link with more than maxProofsPerLink proofs', async () => {
    const server = await keygen();
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: ['*'],
      proofChainLimits: { maxDepth: 2, maxProofsPerLink: 2 },
    });

    const ok = await linearChain(server.did, 2);
    expect(
      (await validator.validate(ok.serialized, TestRead, RESOURCE)).ok,
    ).toBe(true);

    const tooDeep = await linearChain(server.did, 3);
    const deep = await validator.validate(
      tooDeep.serialized,
      TestRead,
      RESOURCE,
    );
    expect(deep.error?.code).toBe('INVALID_FORMAT');
    expect(deep.error?.message).toMatch(/deeper than 2 links/);

    const owner = await keygen();
    const agent = await keygen();
    const proofs = [];
    for (let i = 0; i < 3; i++) {
      proofs.push(
        await Client.delegate({
          issuer: owner.signer,
          audience: agent.signer,
          capabilities: [{ can: 'test/read' as const, with: RESOURCE }],
          facts: [{ n: i }],
        }),
      );
    }
    const wide = await validator.validate(
      await invoke(agent.signer, server.did, proofs),
      TestRead,
      RESOURCE,
    );
    expect(wide.error?.code).toBe('INVALID_FORMAT');
    expect(wide.error?.message).toMatch(/more than 2 proofs/);
  });

  it('counts distinct issuers', async () => {
    const server = await keygen();
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: ['*'],
      proofChainLimits: { maxIssuers: 3 },
    });
    // root -> a -> b -> invoker: 4 issuers (root, a, b, invoker).
    const chain = await linearChain(server.did, 3);
    const result = await validator.validate(
      chain.serialized,
      TestRead,
      RESOURCE,
    );
    expect(result.error?.code).toBe('INVALID_FORMAT');
    expect(result.error?.message).toMatch(/more than 3 issuers/);
  });

  it('can be disabled with proofChainLimits: false', async () => {
    const server = await keygen();
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: ['*'],
      proofChainLimits: false,
    });
    const chain = await linearChain(server.did, 12);
    const result = await validator.validate(
      chain.serialized,
      TestRead,
      RESOURCE,
    );
    expect(result.ok).toBe(true);
    expect(result.proofChain).toHaveLength(13);
  });

  it('bounds validateDelegation() too', async () => {
    const server = await keygen();
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: ['*'],
      proofChainLimits: { maxDepth: 1 },
    });
    const root = await keygen();
    const a = await keygen();
    const b = await keygen();
    const rootToA = await grant(root.signer, a.signer);
    const aToB = await grant(a.signer, b.signer, [rootToA]);
    const bToServer = await Client.delegate({
      issuer: b.signer,
      audience: ed25519.Verifier.parse(server.did),
      capabilities: [{ can: 'test/read' as const, with: RESOURCE }],
      proofs: [aToB],
    });
    const result = await validator.validateDelegation(
      await serializeDelegation(bToServer),
    );
    expect(result.error?.code).toBe('INVALID_FORMAT');
    expect(result.error?.message).toMatch(/deeper than 1 links/);
  });

  it('bounds verification work: 3 repeated capabilities at each of 10 links is refused from 11 nodes', async () => {
    const server = await keygen();
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: ['*'],
    });
    // ucanto branches on every capability of a proof that could match, so the
    // work is 3^11 paths for a token well inside the node/depth/issuer bounds.
    const issuers = [await keygen(), await keygen(), await keygen()];
    const top = await keygen();
    let holder = top;
    let proof: Awaited<ReturnType<typeof Client.delegate>> | undefined;
    for (let i = 0; i < 10; i++) {
      const next = issuers[i % 3]!;
      proof = await Client.delegate({
        issuer: holder.signer,
        audience: next.signer,
        capabilities: [
          { can: 'test/read' as const, with: RESOURCE },
          { can: 'test/read' as const, with: RESOURCE },
          { can: 'test/read' as const, with: RESOURCE },
        ],
        proofs: proof ? [proof] : [],
      });
      holder = next;
    }
    const serialized = await invoke(holder.signer, server.did, [proof!]);
    expect(serialized.length).toBeLessThan(8_000);

    const started = Date.now();
    const result = await validator.validate(serialized, TestRead, RESOURCE);
    expect(Date.now() - started).toBeLessThan(500);
    expect(result.error?.code).toBe('INVALID_FORMAT');
    expect(result.error?.message).toMatch(
      /more than 256 units of verification work/,
    );
  });

  it('bounds verification work by depth too: a wide top over a long tail is refused', async () => {
    const server = await keygen();
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: ['*'],
    });
    // 32 capabilities on the invocation, 16 on its first proof, then a 9-link
    // tail whose top grant does not match: 32 × 16 paths, each verified at
    // every one of ~10 links (about 4.6 k signature checks, ~5 s) while the
    // path count alone stays at 512.
    const top = await keygen();
    let holder = top;
    let proof: Awaited<ReturnType<typeof Client.delegate>> | undefined;
    for (let i = 0; i < 9; i++) {
      const next = await keygen();
      proof = await Client.delegate({
        issuer: holder.signer,
        audience: next.signer,
        capabilities: [
          {
            can: (i === 0 ? 'test/write' : 'test/read') as 'test/read',
            with: RESOURCE,
          },
        ],
        proofs: proof ? [proof] : [],
      });
      holder = next;
    }
    const agent = await keygen();
    const wide = await Client.delegate({
      issuer: holder.signer,
      audience: agent.signer,
      capabilities: Array.from({ length: 16 }, () => ({
        can: 'test/read' as const,
        with: RESOURCE,
      })),
      proofs: [proof!],
    });
    const invocation = await Client.delegate({
      issuer: agent.signer,
      audience: ed25519.Verifier.parse(server.did),
      capabilities: Array.from({ length: 32 }, () => ({
        can: 'test/read' as const,
        with: RESOURCE,
      })),
      proofs: [wide],
    });
    const serialized = await serializeDelegation(invocation);
    expect(serialized.length).toBeLessThan(10_000);

    const started = Date.now();
    const result = await validator.validate(serialized, TestRead, RESOURCE);
    expect(Date.now() - started).toBeLessThan(500);
    expect(result.error?.code).toBe('INVALID_FORMAT');
    expect(result.error?.message).toMatch(/verification work/);
  });

  it('charges real shapes little work: a 3-link chain is 4, a 10-capability bundle two links deep 111, both under the default', async () => {
    const server = await keygen();
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: ['*'],
    });
    const chain = await linearChain(server.did, 3);
    expect(
      (await validator.validate(chain.serialized, TestRead, RESOURCE)).ok,
    ).toBe(true);

    const owner = await keygen();
    const oracle = await keygen();
    const agent = await keygen();
    const bundle = Array.from({ length: 10 }, (_, i) => ({
      can: (i === 0 ? 'test/read' : 'test/write') as 'test/read',
      with: RESOURCE,
    }));
    const toOracle = await Client.delegate({
      issuer: owner.signer,
      audience: oracle.signer,
      capabilities: bundle,
    });
    const toAgent = await Client.delegate({
      issuer: oracle.signer,
      audience: agent.signer,
      capabilities: bundle,
      proofs: [toOracle],
    });
    // work = 1 × (1 + 10 × (1 + 10 × 1)) = 111
    const result = await validator.validate(
      await invoke(agent.signer, server.did, [toAgent]),
      TestRead,
      RESOURCE,
    );
    expect(result.ok).toBe(true);
    expect(result.proofChain).toEqual([owner.did, oracle.did, agent.did]);
  });

  it('bounds capabilities per link', async () => {
    const server = await keygen();
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: ['*'],
      proofChainLimits: { maxCapabilitiesPerLink: 2 },
    });
    const owner = await keygen();
    const agent = await keygen();
    const bundle = await Client.delegate({
      issuer: owner.signer,
      audience: agent.signer,
      capabilities: [
        { can: 'test/read' as const, with: RESOURCE },
        { can: 'test/write' as const, with: RESOURCE },
        { can: 'test/read' as const, with: 'ixo:other' as const },
      ],
    });
    const result = await validator.validate(
      await invoke(agent.signer, server.did, [bundle]),
      TestRead,
      RESOURCE,
    );
    expect(result.error?.code).toBe('INVALID_FORMAT');
    expect(result.error?.message).toMatch(/more than 2 capabilities/);
  });

  it('keeps the default for an override key that is undefined', async () => {
    const server = await keygen();
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: ['*'],
      proofChainLimits: { maxDepth: undefined, maxNodes: 3 },
    });
    const chain = await linearChain(server.did, 3); // 4 nodes
    const result = await validator.validate(
      chain.serialized,
      TestRead,
      RESOURCE,
    );
    expect(result.error?.message).toMatch(/more than 3 nodes/);
  });

  it('a proof that travelled as a bare CID link counts as one node and is refused, not thrown on', async () => {
    const server = await keygen();
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: ['*'],
    });
    const root = await keygen();
    const agent = await keygen();
    const rootToAgent = await grant(root.signer, agent.signer);
    // Attach the parent's CID only, not its block: the chain cannot be
    // verified, but the walk must not throw.
    const invocation = Client.invoke({
      issuer: agent.signer,
      audience: ed25519.Verifier.parse(server.did),
      capability: { can: 'test/read' as const, with: RESOURCE },
      proofs: [rootToAgent.cid],
    });
    const result = await validator.validate(
      await serializeInvocation(invocation),
      TestRead,
      RESOURCE,
    );
    // The chain cannot be proven (the parent's block is missing); a throw in
    // the walk would surface as INVALID_FORMAT instead.
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNAUTHORIZED');

    // Same for a delegation handed to validateDelegation().
    const toServer = await Client.delegate({
      issuer: agent.signer,
      audience: ed25519.Verifier.parse(server.did),
      capabilities: [{ can: 'test/read' as const, with: RESOURCE }],
      proofs: [rootToAgent.cid],
    });
    const delegated = await validator.validateDelegation(
      await serializeDelegation(toServer),
    );
    expect(delegated.ok).toBe(false);
    expect(delegated.error?.code).toBe('UNAUTHORIZED');
    expect(delegated.error?.message).toMatch(/Proof chain incomplete/);
  });

  it('rejects invalid limit values when the validator is created', async () => {
    const server = await keygen();
    await expect(
      createUCANValidator({
        serverDid: server.did,
        rootIssuers: ['*'],
        proofChainLimits: { maxNodes: 0 },
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      createUCANValidator({
        serverDid: server.did,
        rootIssuers: ['*'],
        maxErrorMessageChars: 1.5,
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      createUCANValidator({
        serverDid: server.did,
        rootIssuers: ['*'],
        maxCapabilities: -1,
      }),
    ).rejects.toThrow(RangeError);
  });
});

describe('error message length', () => {
  it('cuts messages longer than maxErrorMessageChars and marks the cut', async () => {
    const server = await keygen();
    const other = await keygen();
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: ['*'],
      maxErrorMessageChars: 24,
    });
    // Addressed to another server: a long, deterministic UNAUTHORIZED message.
    const serialized = await invoke(other.signer, other.did, []);
    const result = await validator.validate(serialized, TestRead, RESOURCE);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNAUTHORIZED');
    expect(result.error?.message).toHaveLength(24);
    expect(result.error?.message.endsWith('…')).toBe(true);
    expect(result.error?.message.startsWith('Invocation addressed')).toBe(true);
  });

  it('leaves short messages alone', async () => {
    const server = await keygen();
    const other = await keygen();
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: ['*'],
    });
    const serialized = await invoke(other.signer, other.did, []);
    const result = await validator.validate(serialized, TestRead, RESOURCE);
    expect(result.error?.message).toBe(
      `Invocation addressed to ${other.did}, not ${server.did}`,
    );
  });
});

describe('capability count and pinning', () => {
  const A = 'ixo:company/A' as const;
  const B = 'ixo:company/B' as const;

  /** read-on-B listed first (unproven), write-on-A second (proven). */
  async function twoCapabilityInvocation(serverDid: string) {
    const root = await keygen();
    const user = await keygen();
    const writeA = await Client.delegate({
      issuer: root.signer,
      audience: user.signer,
      capabilities: [{ can: 'test/write' as const, with: A }],
    });
    const invocation = await Client.delegate({
      issuer: user.signer,
      audience: ed25519.Verifier.parse(serverDid),
      capabilities: [
        { can: 'test/read' as const, with: B },
        { can: 'test/write' as const, with: A },
      ],
      proofs: [writeA],
    });
    return { root, user, serialized: await serializeDelegation(invocation) };
  }

  it('accepts a multi-capability invocation by default and reports the authorised one', async () => {
    const server = await keygen();
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: ['*'],
    });
    const { serialized } = await twoCapabilityInvocation(server.did);
    const result = await validator.validate(serialized, TestWrite, A);
    expect(result.ok).toBe(true);
    expect(result.capability).toEqual({ can: 'test/write', with: A });
  });

  it('refuses a multi-capability invocation when maxCapabilities is 1, before any verification', async () => {
    const server = await keygen();
    const { resolver, calls } = countingResolver({});
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: ['*'],
      maxCapabilities: 1,
      didResolver: resolver,
    });
    const { serialized } = await twoCapabilityInvocation(server.did);
    const result = await validator.validate(serialized, TestWrite, A);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_FORMAT');
    expect(result.error?.message).toMatch(/carries 2 capabilities/);
    expect(calls).toHaveLength(0);
  });

  it('expect: refuses when the authorised capability is not the one the caller read', async () => {
    const server = await keygen();
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: ['*'],
    });
    const { serialized } = await twoCapabilityInvocation(server.did);
    // The caller read capabilities[0] (read on B) and will route by it, but
    // ucanto proves write on A.
    const result = await validator.validate(serialized, TestWrite, A, {
      expect: { can: 'test/read', with: B },
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNAUTHORIZED');
    expect(result.error?.message).toMatch(/is not the expected/);
  });

  it('expect: accepts an exact match and pins `with` without wildcard tolerance', async () => {
    const server = await keygen();
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: ['*'],
    });
    const user = await keygen();
    const exact = await validator.validate(
      await invoke(user.signer, server.did, [], 'test/read', RESOURCE),
      TestRead,
      RESOURCE,
      { expect: { can: 'test/read', with: RESOURCE } },
    );
    expect(exact.ok).toBe(true);

    // A `/*` resource is a prefix match for `resource` (unchanged), but not
    // for `expect.with`.
    const wild = (nonce: string) =>
      invoke(user.signer, server.did, [], 'test/read', 'ixo:company/*', nonce);
    const tolerant = await validator.validate(
      await wild('1'),
      TestRead,
      'ixo:company/A',
    );
    expect(tolerant.ok).toBe(true);
    const pinned = await validator.validate(
      await wild('2'),
      TestRead,
      'ixo:company/A',
      { expect: { with: 'ixo:company/A' } },
    );
    expect(pinned.ok).toBe(false);
    expect(pinned.error?.code).toBe('UNAUTHORIZED');
  });

  it('expect: compares `with` in the URL-canonical form ucanto reports', async () => {
    const server = await keygen();
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: ['*'],
    });
    const user = await keygen();
    // The token says `IXO:company/A`; ucanto reports `ixo:company/A`. A caller
    // that read the raw string still pins the same resource.
    const token = (nonce: string) =>
      invoke(
        user.signer,
        server.did,
        [],
        'test/read',
        'IXO:company/A' as `ixo:${string}`,
        nonce,
      );
    const raw = await validator.validate(
      await token('1'),
      TestRead,
      'ixo:company/A',
      {
        expect: { with: 'IXO:company/A' },
      },
    );
    expect(raw.ok).toBe(true);
    expect(raw.capability?.with).toBe('ixo:company/A');
    const other = await validator.validate(
      await token('2'),
      TestRead,
      'ixo:company/A',
      {
        expect: { with: 'ixo:company/B' },
      },
    );
    expect(other.error?.code).toBe('UNAUTHORIZED');
  });
});

describe('universal resource ucan:*', () => {
  async function universalProofInvocation(serverDid: string) {
    const root = await keygen();
    const user = await keygen();
    const universal = await Client.delegate({
      issuer: root.signer,
      audience: user.signer,
      capabilities: [{ can: 'test/read' as const, with: 'ucan:*' as const }],
    });
    return {
      root,
      user,
      serialized: await invoke(user.signer, serverDid, [universal]),
    };
  }

  it('is accepted by default, as before', async () => {
    const server = await keygen();
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: ['*'],
    });
    const { root, user, serialized } = await universalProofInvocation(
      server.did,
    );
    const result = await validator.validate(serialized, TestRead, RESOURCE);
    expect(result.ok).toBe(true);
    expect(result.proofChain).toEqual([root.did, user.did]);
  });

  it('is refused anywhere in the chain when allowUniversalResource is false', async () => {
    const server = await keygen();
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: ['*'],
      allowUniversalResource: false,
    });
    const { serialized } = await universalProofInvocation(server.did);
    const result = await validator.validate(serialized, TestRead, RESOURCE);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNAUTHORIZED');
    expect(result.error?.message).toMatch(/ucan:\*/);

    // A plain chain is unaffected.
    const chain = await linearChain(server.did, 2);
    expect(
      (await validator.validate(chain.serialized, TestRead, RESOURCE)).ok,
    ).toBe(true);
  });

  it('stays linear in the token size with the shape limits off (shared blocks are visited once)', async () => {
    const server = await keygen();
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: ['*'],
      allowUniversalResource: false,
      proofChainLimits: false,
    });
    const owner = await keygen();
    const attacker = await keygen();
    // `ucan:*` sits at the bottom of a tree that references the same block
    // three times at each of ten levels (3^10 paths, 12 distinct blocks).
    let level = await Client.delegate({
      issuer: owner.signer,
      audience: attacker.signer,
      capabilities: [{ can: 'test/read' as const, with: 'ucan:*' as const }],
    });
    for (let i = 0; i < 10; i++) {
      level = await grant(attacker.signer, attacker.signer, [
        level,
        level,
        level,
      ]);
    }
    const serialized = await invoke(attacker.signer, server.did, [level]);
    const started = Date.now();
    const result = await validator.validate(serialized, TestRead, RESOURCE);
    expect(Date.now() - started).toBeLessThan(500);
    expect(result.error?.code).toBe('UNAUTHORIZED');
    expect(result.error?.message).toMatch(/ucan:\*/);
  });

  it('applies to validateDelegation() as well', async () => {
    const server = await keygen();
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: ['*'],
      allowUniversalResource: false,
    });
    const root = await keygen();
    const delegation = await Client.delegate({
      issuer: root.signer,
      audience: ed25519.Verifier.parse(server.did),
      capabilities: [{ can: 'test/read' as const, with: 'ucan:*' as const }],
    });
    const result = await validator.validateDelegation(
      await serializeDelegation(delegation),
    );
    expect(result.error?.code).toBe('UNAUTHORIZED');
  });
});

describe('DID resolution is memoised per validation', () => {
  const ownerDid = 'did:ixo:ixo1owner' as const;

  it('resolves a DID that issues several proofs of one invocation once', async () => {
    const server = await keygen();
    const ownerKey = await keygen();
    const agent = await keygen();
    const { resolver, calls } = countingResolver({
      [ownerDid]: [ownerKey.did as KeyDID],
    });
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: ['*'],
      didResolver: resolver,
    });

    const proofs = [];
    for (let i = 0; i < 4; i++) {
      proofs.push(
        await Client.delegate({
          issuer: ownerKey.signer.withDID(ownerDid),
          audience: agent.signer,
          capabilities: [{ can: 'test/read' as const, with: RESOURCE }],
          facts: [{ n: i }],
        }),
      );
    }
    const serialized = await invoke(agent.signer, server.did, proofs);

    const first = await validator.validate(serialized, TestRead, RESOURCE);
    expect(first.ok).toBe(true);
    expect(first.proofChain).toEqual([ownerDid, agent.did]);
    expect(calls.filter((d) => d === ownerDid)).toHaveLength(1);

    // Nothing is kept across validations: a second (fresh) invocation
    // resolves again.
    const again = await validator.validate(
      await invoke(
        agent.signer,
        server.did,
        proofs,
        'test/read',
        RESOURCE,
        '2',
      ),
      TestRead,
      RESOURCE,
    );
    expect(again.ok).toBe(true);
    expect(calls.filter((d) => d === ownerDid)).toHaveLength(2);
  });

  it('memoises in validateDelegation() too', async () => {
    const server = await keygen();
    const ownerKey = await keygen();
    const agent = await keygen();
    const { resolver, calls } = countingResolver({
      [ownerDid]: [ownerKey.did as KeyDID],
    });
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: ['*'],
      didResolver: resolver,
    });
    // owner -> agent, owner -> agent (two grants), agent -> server with both.
    const g1 = await Client.delegate({
      issuer: ownerKey.signer.withDID(ownerDid),
      audience: agent.signer,
      capabilities: [{ can: 'test/read' as const, with: RESOURCE }],
      facts: [{ n: 1 }],
    });
    const g2 = await Client.delegate({
      issuer: ownerKey.signer.withDID(ownerDid),
      audience: agent.signer,
      capabilities: [{ can: 'test/read' as const, with: RESOURCE }],
      facts: [{ n: 2 }],
    });
    const toServer = await Client.delegate({
      issuer: agent.signer,
      audience: ed25519.Verifier.parse(server.did),
      capabilities: [{ can: 'test/read' as const, with: RESOURCE }],
      proofs: [g1, g2],
    });
    const result = await validator.validateDelegation(
      await serializeDelegation(toServer),
    );
    expect(result.ok).toBe(true);
    expect(calls.filter((d) => d === ownerDid)).toHaveLength(1);
  });
});

describe('resource-scoped self-issue names the authority only', () => {
  const did = 'did:web:alice.example' as const;

  it('resourceNamesIssuer: authority, authority suffix, or first path segment', () => {
    expect(resourceNamesIssuer(did, did)).toBe(true);
    expect(resourceNamesIssuer(`ixo:${did}`, did)).toBe(true);
    expect(resourceNamesIssuer(`ixo:${did}/files`, did)).toBe(true);
    expect(resourceNamesIssuer(`ixo:tenant:${did}`, did)).toBe(true);
    expect(resourceNamesIssuer(`ixo:tenant/${did}`, did)).toBe(true);
    expect(resourceNamesIssuer(`ixo:tenant/${did}/files`, did)).toBe(true);

    // A DID authority names exactly that DID: no suffix match (a did:web may
    // contain `:did:`), and nothing below it counts. Query and fragment stay
    // part of the string, as in 2.2.1.
    const alice = 'did:key:z6MkAlice';
    const aliceWeb = 'did:web:alice.com';
    expect(resourceNamesIssuer(`ixo:${alice}/${did}`, did)).toBe(false);
    expect(resourceNamesIssuer(`${alice}/${did}`, did)).toBe(false);
    expect(resourceNamesIssuer(`ixo:${alice}:${did}`, did)).toBe(false);
    expect(resourceNamesIssuer(`ixo:${aliceWeb}:${did}`, did)).toBe(false);
    expect(
      resourceNamesIssuer(`ixo:${aliceWeb}:${did}`, `${aliceWeb}:${did}`),
    ).toBe(true);
    expect(resourceNamesIssuer(`ixo:tenant:${alice}/${did}`, did)).toBe(false);
    expect(resourceNamesIssuer(`ixo:${alice}?q=:${did}`, did)).toBe(false);
    expect(resourceNamesIssuer(`ixo:${alice}#${did}`, did)).toBe(false);
    expect(resourceNamesIssuer(`ixo:/${did}`, did)).toBe(false); // empty authority
    expect(resourceNamesIssuer(`ixo:${did}?x=1`, did)).toBe(false);

    // Deeper than the first path segment: someone else's resource that
    // mentions the DID (a folder shared with it).
    expect(resourceNamesIssuer(`ixo:filesystem/alice/${did}`, did)).toBe(false);
    expect(resourceNamesIssuer(`ixo:filesystem/alice/${did}/x`, did)).toBe(
      false,
    );
    // Prefix of a longer DID, or part of a longer segment.
    expect(resourceNamesIssuer(`ixo:${did}.evil`, did)).toBe(false);
    expect(resourceNamesIssuer(`ixo:tenant/${did}m/files`, did)).toBe(false);
    expect(resourceNamesIssuer(`ixo:tenant/x${did}`, did)).toBe(false);
    expect(resourceNamesIssuer('ixo:tenant', did)).toBe(false);
    expect(resourceNamesIssuer(`ixo:tenant/${did}`, '')).toBe(false);
  });

  it('refuses a self-issued invocation on a resource that names the issuer below the first path segment', async () => {
    const server = await keygen();
    const unrelatedRoot = await keygen();
    const aliceKey = await keygen();
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: [unrelatedRoot.did],
      didResolver: async (d) =>
        d === did
          ? { ok: [aliceKey.did as KeyDID] }
          : { error: { name: 'NotFound', did: d, message: 'Unknown DID' } },
    });

    const shared = `ixo:filesystem/bob/${did}` as const;
    const refused = await validator.validate(
      await invoke(
        aliceKey.signer.withDID(did),
        server.did,
        [],
        'test/read',
        shared,
      ),
      TestRead,
      shared,
    );
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe('UNAUTHORIZED');

    const own = `ixo:filesystem/${did}/docs` as const;
    const accepted = await validator.validate(
      await invoke(
        aliceKey.signer.withDID(did),
        server.did,
        [],
        'test/read',
        own,
      ),
      TestRead,
      own,
    );
    expect(accepted.ok).toBe(true);
    expect(accepted.proofChain).toEqual([did]);
  });
});

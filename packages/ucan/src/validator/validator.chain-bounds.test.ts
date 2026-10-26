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
      maxNodes: 32,
      maxProofsPerLink: 16,
      maxIssuers: 8,
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
    expect(result.error?.message).toMatch(/Proof chain has more than 32 nodes/);
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
    expect(result.error?.message).toHaveLength(25);
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

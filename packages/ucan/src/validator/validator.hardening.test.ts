import { describe, expect, it } from 'vitest';
import * as Client from '@ucanto/client';
import { ed25519 } from '@ucanto/principal';
import { createUCANValidator } from './validator.js';
import { defineCapability, Schema } from '../capabilities/capability.js';
import {
  getDelegationCid,
  serializeDelegation,
  serializeInvocation,
} from '../client/create-client.js';
import { InMemoryInvocationStore } from '../store/memory.js';
import type { DIDKeyResolver, InvocationStore, KeyDID } from '../types.js';
import { base58Encode } from '../did/utils.js';

async function keygen() {
  const signer = await ed25519.Signer.generate();
  return { signer, did: signer.did() };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Resolver over a fixed DID -> did:key table. */
function tableResolver(table: Record<string, KeyDID[]>): DIDKeyResolver {
  return async (did) => {
    const keys = table[did];
    if (keys) return { ok: keys };
    return { error: { name: 'NotFound', did, message: 'Unknown DID' } };
  };
}

const TestRead = defineCapability({ can: 'test/read', protocol: 'ixo:' });

const EmployeesRead = defineCapability({
  can: 'employees/read',
  protocol: 'myapp:',
});

const EmployeesWrite = defineCapability({
  can: 'employees/write',
  protocol: 'myapp:',
});

const PaySend = defineCapability({
  can: 'pay/send',
  protocol: 'myapp:',
  nb: { amount: Schema.integer() },
  derives: (claimed, delegated) =>
    (claimed.nb?.amount ?? Infinity) <= (delegated.nb?.amount ?? Infinity)
      ? { ok: {} }
      : { error: new Error('amount exceeds the delegated limit') },
});

describe('validate() reports the capability ucanto authorised', () => {
  it('rejects a write on B when the invocation lists read-on-B first and the authorised write-on-A second', async () => {
    const server = await keygen();
    const root = await keygen();
    const user = await keygen();
    const A = 'myapp:company/A' as const;
    const B = 'myapp:company/B' as const;

    const writeA = await Client.delegate({
      issuer: root.signer,
      audience: user.signer,
      capabilities: [{ can: 'employees/write' as const, with: A }],
    });
    const readB = await Client.delegate({
      issuer: root.signer,
      audience: user.signer,
      capabilities: [{ can: 'employees/read' as const, with: B }],
    });

    const invocation = await Client.delegate({
      issuer: user.signer,
      audience: ed25519.Verifier.parse(server.did),
      capabilities: [
        { can: 'employees/read' as const, with: B },
        { can: 'employees/write' as const, with: A },
      ],
      proofs: [writeA, readB],
    });
    const token = await serializeDelegation(invocation);

    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: [root.did],
    });

    const escalated = await validator.validate(token, EmployeesWrite, B);
    expect(escalated.ok).toBe(false);
    expect(escalated.error?.code).toBe('UNAUTHORIZED');

    // The same token still proves what it really authorises.
    const genuine = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: [root.did],
    });
    const result = await genuine.validate(token, EmployeesWrite, A);
    expect(result.ok).toBe(true);
    expect(result.capability).toStrictEqual({
      can: 'employees/write',
      with: A,
      nb: undefined,
    });

    const reader = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: [root.did],
    });
    const read = await reader.validate(token, EmployeesRead, B);
    expect(read.ok).toBe(true);
    expect(read.capability?.can).toBe('employees/read');
    expect(read.capability?.with).toBe(B);
  });

  it('returns the nb of the authorised capability, not a larger caveat in an earlier escalating one', async () => {
    const server = await keygen();
    const root = await keygen();
    const user = await keygen();
    const R = 'myapp:wallet/1' as const;

    const grant = await Client.delegate({
      issuer: root.signer,
      audience: user.signer,
      capabilities: [{ can: 'pay/send' as const, with: R, nb: { amount: 10 } }],
    });
    const invocation = await Client.delegate({
      issuer: user.signer,
      audience: ed25519.Verifier.parse(server.did),
      capabilities: [
        { can: 'pay/send' as const, with: R, nb: { amount: 1000 } },
        { can: 'pay/send' as const, with: R, nb: { amount: 5 } },
      ],
      proofs: [grant],
    });

    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: [root.did],
    });
    const result = await validator.validate(
      await serializeDelegation(invocation),
      PaySend,
      R,
    );

    expect(result.ok).toBe(true);
    expect(result.capability).toEqual({
      can: 'pay/send',
      with: R,
      nb: { amount: 5 },
    });
  });

  it('never reports an unauthorised first capability (other ability, smuggled nb)', async () => {
    const server = await keygen();
    const root = await keygen();
    const user = await keygen();
    const R = 'myapp:wallet/1' as const;

    const grant = await Client.delegate({
      issuer: root.signer,
      audience: user.signer,
      capabilities: [{ can: 'pay/send' as const, with: R, nb: { amount: 10 } }],
    });
    const invocation = await Client.delegate({
      issuer: user.signer,
      audience: ed25519.Verifier.parse(server.did),
      capabilities: [
        { can: 'pay/drain' as const, with: R, nb: { amount: 999_999 } },
        { can: 'pay/send' as const, with: R, nb: { amount: 5 } },
      ],
      proofs: [grant],
    });

    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: [root.did],
    });
    const result = await validator.validate(
      await serializeDelegation(invocation),
      PaySend,
      R,
    );

    expect(result.ok).toBe(true);
    expect(result.capability?.can).toBe('pay/send');
    expect(result.capability?.nb).toEqual({ amount: 5 });
  });

  it('leaves a single-capability invocation unchanged', async () => {
    const server = await keygen();
    const root = await keygen();
    const user = await keygen();
    const R = 'myapp:wallet/1' as const;

    const grant = await Client.delegate({
      issuer: root.signer,
      audience: user.signer,
      capabilities: [{ can: 'pay/send' as const, with: R, nb: { amount: 10 } }],
    });
    const invocation = Client.invoke({
      issuer: user.signer,
      audience: ed25519.Verifier.parse(server.did),
      capability: { can: 'pay/send' as const, with: R, nb: { amount: 7 } },
      proofs: [grant],
    });

    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: [root.did],
    });
    const result = await validator.validate(
      await serializeInvocation(invocation),
      PaySend,
      R,
    );

    expect(result.ok).toBe(true);
    expect(result.invoker).toBe(user.did);
    expect(result.capability).toEqual({
      can: 'pay/send',
      with: R,
      nb: { amount: 7 },
    });
    expect(result.proofChain).toEqual([root.did, user.did]);
  });
});

describe('resource-scoped self-issue', () => {
  const victimDid = 'did:web:victim.com' as const;
  const attackerDid = 'did:web:victim.co' as const;

  async function setup() {
    const server = await keygen();
    const unrelatedRoot = await keygen();
    const victimKey = await keygen();
    const attackerKey = await keygen();
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: [unrelatedRoot.did],
      didResolver: tableResolver({
        [victimDid]: [victimKey.did],
        [attackerDid]: [attackerKey.did],
      }),
    });
    return { server, victimKey, attackerKey, validator };
  }

  async function selfIssued(
    signer: Awaited<ReturnType<typeof keygen>>['signer'],
    did: `did:${string}:${string}`,
    serverDid: string,
    resource: `ixo:${string}`,
  ) {
    return serializeInvocation(
      Client.invoke({
        issuer: signer.withDID(did),
        audience: ed25519.Verifier.parse(serverDid),
        capability: { can: 'test/read' as const, with: resource },
        proofs: [],
      }),
    );
  }

  it('refuses an issuer whose DID is a strict prefix of the DID named in the resource', async () => {
    const { server, attackerKey, validator } = await setup();
    const resource = `ixo:tenant/${victimDid}` as const;

    const result = await validator.validate(
      await selfIssued(attackerKey.signer, attackerDid, server.did, resource),
      TestRead,
      resource,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNAUTHORIZED');
  });

  it('refuses an issuer named only as part of a longer path segment', async () => {
    const { server, attackerKey, validator } = await setup();
    const resource = `ixo:tenant/${attackerDid}m/files` as const;

    const result = await validator.validate(
      await selfIssued(attackerKey.signer, attackerDid, server.did, resource),
      TestRead,
      resource,
    );

    expect(result.ok).toBe(false);
  });

  it('accepts the DID owner self-issuing on a resource that names it as a whole segment', async () => {
    const { server, victimKey, validator } = await setup();

    for (const resource of [
      `ixo:tenant/${victimDid}`,
      `ixo:tenant/${victimDid}/files`,
      `ixo:${victimDid}`,
    ] as const) {
      const result = await validator.validate(
        await selfIssued(victimKey.signer, victimDid, server.did, resource),
        TestRead,
        resource,
      );
      expect({ resource, ok: result.ok }).toEqual({ resource, ok: true });
      expect(result.proofChain).toEqual([victimDid]);
    }
  });
});

describe('replay protection', () => {
  async function delegatedToken(opts: { expiration?: number } = {}) {
    const server = await keygen();
    const root = await keygen();
    const user = await keygen();
    const grant = await Client.delegate({
      issuer: root.signer,
      audience: user.signer,
      capabilities: [
        { can: 'test/read' as const, with: 'ixo:resource:1' as const },
      ],
    });
    const token = await serializeInvocation(
      Client.invoke({
        issuer: user.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: { can: 'test/read' as const, with: 'ixo:resource:1' },
        proofs: [grant],
        ...(opts.expiration !== undefined
          ? { expiration: opts.expiration }
          : {}),
      }),
    );
    return { server, root, user, token };
  }

  it('accepts exactly one of two concurrent validations of the same invocation', async () => {
    const { server, root, token } = await delegatedToken();
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: [root.did],
    });

    const results = await Promise.all([
      validator.validate(token, TestRead, 'ixo:resource:1'),
      validator.validate(token, TestRead, 'ixo:resource:1'),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => r.error?.code === 'REPLAY')).toHaveLength(1);
  });

  it('accepts exactly one of two concurrent validations through two validators sharing one store', async () => {
    const { server, root, token } = await delegatedToken();
    const invocationStore = new InMemoryInvocationStore({
      enableAutoCleanup: false,
    });
    const make = () =>
      createUCANValidator({
        serverDid: server.did,
        rootIssuers: [root.did],
        invocationStore,
      });
    const [a, b] = await Promise.all([make(), make()]);

    const results = await Promise.all([
      a.validate(token, TestRead, 'ixo:resource:1'),
      b.validate(token, TestRead, 'ixo:resource:1'),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => r.error?.code === 'REPLAY')).toHaveLength(1);
  });

  it('accepts exactly one of two concurrent validations with a custom store that has only has/add', async () => {
    const { server, root, token } = await delegatedToken();
    const seen = new Set<string>();
    const invocationStore: InvocationStore = {
      has: async (cid) => seen.has(cid),
      add: async (cid) => {
        seen.add(cid);
      },
    };
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: [root.did],
      invocationStore,
    });

    const results = await Promise.all([
      validator.validate(token, TestRead, 'ixo:resource:1'),
      validator.validate(token, TestRead, 'ixo:resource:1'),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => r.error?.code === 'REPLAY')).toHaveLength(1);
    expect(seen.size).toBe(1);
  });

  it('keeps the replay entry for the lifetime of the invocation, not the store default', async () => {
    const expiration = nowSeconds() + 120;
    const { server, root, token } = await delegatedToken({ expiration });
    const ttls: Array<number | undefined> = [];
    const inner = new InMemoryInvocationStore({ enableAutoCleanup: false });
    const invocationStore: InvocationStore = {
      has: (cid) => inner.has(cid),
      add: (cid, ttlMs) => {
        ttls.push(ttlMs);
        return inner.add(cid, ttlMs);
      },
    };
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: [root.did],
      invocationStore,
    });

    const result = await validator.validate(token, TestRead, 'ixo:resource:1');
    expect(result.ok).toBe(true);
    expect(ttls).toHaveLength(1);
    const ttl = ttls[0];
    expect(ttl).toBeDefined();
    const entryExpiresAt = Date.now() + (ttl ?? 0);
    // At or after the token's own expiry, and not the 24 h default.
    expect(entryExpiresAt).toBeGreaterThanOrEqual(expiration * 1000);
    expect(entryExpiresAt).toBeLessThan(expiration * 1000 + 5 * 60 * 1000);
  });

  it('passes the token-derived TTL to an atomic store too', async () => {
    const expiration = nowSeconds() + 300;
    const { server, root, token } = await delegatedToken({ expiration });
    const marks: Array<{ cid: string; ttlMs: number | undefined }> = [];
    const inner = new InMemoryInvocationStore({ enableAutoCleanup: false });
    const invocationStore: InvocationStore = {
      has: (cid) => inner.has(cid),
      add: (cid, ttlMs) => inner.add(cid, ttlMs),
      addIfAbsent: (cid, ttlMs) => {
        marks.push({ cid, ttlMs });
        return inner.addIfAbsent(cid, ttlMs);
      },
      delete: (cid) => inner.delete(cid),
    };
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: [root.did],
      invocationStore,
    });

    const result = await validator.validate(token, TestRead, 'ixo:resource:1');
    expect(result.ok).toBe(true);
    expect(marks).toHaveLength(1);
    expect(marks[0]?.cid).toBe(await getDelegationCid(token));
    const entryExpiresAt = Date.now() + (marks[0]?.ttlMs ?? 0);
    expect(entryExpiresAt).toBeGreaterThanOrEqual(expiration * 1000);
    expect(entryExpiresAt).toBeLessThan(expiration * 1000 + 5 * 60 * 1000);
    expect(await inner.has(await getDelegationCid(token))).toBe(true);
  });

  it('does not burn the token when validation fails after the replay mark', async () => {
    const { server, root, user, token } = await delegatedToken();
    let checkerUp = false;
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: [root.did],
      revocationChecker: {
        check: async () => {
          if (!checkerUp) throw new Error('store unavailable');
          return [];
        },
      },
    });

    const wrongResource = await validator.validate(
      token,
      TestRead,
      'ixo:resource:2',
    );
    expect(wrongResource.ok).toBe(false);
    expect(wrongResource.error?.code).toBe('UNAUTHORIZED');

    const checkerDown = await validator.validate(
      token,
      TestRead,
      'ixo:resource:1',
    );
    expect(checkerDown.error?.code).toBe('REVOCATION_CHECK_FAILED');

    checkerUp = true;
    const accepted = await validator.validate(
      token,
      TestRead,
      'ixo:resource:1',
    );
    expect(accepted.ok).toBe(true);
    expect(accepted.invoker).toBe(user.did);

    const replay = await validator.validate(token, TestRead, 'ixo:resource:1');
    expect(replay.error?.code).toBe('REPLAY');
  });
});

describe('effective expiry and not-before', () => {
  it('validateDelegation() rejects a chain whose second proof has expired', async () => {
    const server = await keygen();
    const rootA = await keygen();
    const rootB = await keygen();
    const user = await keygen();

    const valid = await Client.delegate({
      issuer: rootA.signer,
      audience: user.signer,
      capabilities: [{ can: '*' as const, with: 'ixo:oracle' as const }],
      expiration: nowSeconds() + 3600,
    });
    const expired = await Client.delegate({
      issuer: rootB.signer,
      audience: user.signer,
      capabilities: [{ can: '*' as const, with: 'ixo:oracle' as const }],
      expiration: nowSeconds() - 60,
    });
    const delegation = await Client.delegate({
      issuer: user.signer,
      audience: ed25519.Verifier.parse(server.did),
      capabilities: [{ can: '*' as const, with: 'ixo:oracle' as const }],
      expiration: nowSeconds() + 3600,
      proofs: [valid, expired],
    });

    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: [],
    });
    const result = await validator.validateDelegation(
      await serializeDelegation(delegation),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('EXPIRED');
  });

  it('validateDelegation() reports the earliest expiry over every proof', async () => {
    const server = await keygen();
    const rootA = await keygen();
    const rootB = await keygen();
    const user = await keygen();
    const early = nowSeconds() + 600;

    const late = await Client.delegate({
      issuer: rootA.signer,
      audience: user.signer,
      capabilities: [{ can: '*' as const, with: 'ixo:oracle' as const }],
      expiration: nowSeconds() + 7200,
    });
    const soon = await Client.delegate({
      issuer: rootB.signer,
      audience: user.signer,
      capabilities: [{ can: '*' as const, with: 'ixo:oracle' as const }],
      expiration: early,
    });
    const delegation = await Client.delegate({
      issuer: user.signer,
      audience: ed25519.Verifier.parse(server.did),
      capabilities: [{ can: '*' as const, with: 'ixo:oracle' as const }],
      expiration: nowSeconds() + 3600,
      proofs: [late, soon],
    });

    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: [],
    });
    const result = await validator.validateDelegation(
      await serializeDelegation(delegation),
    );

    expect(result.ok).toBe(true);
    expect(result.expiration).toBe(early);
  });

  it('validateDelegation() rejects a delegation that is not valid yet', async () => {
    const server = await keygen();
    const user = await keygen();
    const delegation = await Client.delegate({
      issuer: user.signer,
      audience: ed25519.Verifier.parse(server.did),
      capabilities: [{ can: '*' as const, with: 'ixo:oracle' as const }],
      expiration: nowSeconds() + 7200,
      notBefore: nowSeconds() + 3600,
    });

    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: [],
    });
    const result = await validator.validateDelegation(
      await serializeDelegation(delegation),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNAUTHORIZED');
  });

  it('validateDelegation() rejects a chain whose proof is not valid yet', async () => {
    const server = await keygen();
    const root = await keygen();
    const user = await keygen();
    const future = await Client.delegate({
      issuer: root.signer,
      audience: user.signer,
      capabilities: [{ can: '*' as const, with: 'ixo:oracle' as const }],
      expiration: nowSeconds() + 7200,
      notBefore: nowSeconds() + 3600,
    });
    const delegation = await Client.delegate({
      issuer: user.signer,
      audience: ed25519.Verifier.parse(server.did),
      capabilities: [{ can: '*' as const, with: 'ixo:oracle' as const }],
      expiration: nowSeconds() + 7200,
      proofs: [future],
    });

    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: [],
    });
    const result = await validator.validateDelegation(
      await serializeDelegation(delegation),
    );

    expect(result.ok).toBe(false);
  });

  it('validateDelegation() accepts a not-before in the past', async () => {
    const server = await keygen();
    const user = await keygen();
    const delegation = await Client.delegate({
      issuer: user.signer,
      audience: ed25519.Verifier.parse(server.did),
      capabilities: [{ can: '*' as const, with: 'ixo:oracle' as const }],
      expiration: nowSeconds() + 3600,
      notBefore: nowSeconds() - 60,
    });

    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: [],
    });
    const result = await validator.validateDelegation(
      await serializeDelegation(delegation),
    );

    expect(result.ok).toBe(true);
  });

  it('validate() reports the expiry of the verified path, not of an unrelated first proof', async () => {
    const server = await keygen();
    const root = await keygen();
    const user = await keygen();
    const verifiedExpiry = nowSeconds() + 600;

    const unrelated = await Client.delegate({
      issuer: root.signer,
      audience: user.signer,
      capabilities: [
        { can: 'other/thing' as const, with: 'ixo:resource:1' as const },
      ],
      expiration: nowSeconds() + 7200,
    });
    const real = await Client.delegate({
      issuer: root.signer,
      audience: user.signer,
      capabilities: [
        { can: 'test/read' as const, with: 'ixo:resource:1' as const },
      ],
      expiration: verifiedExpiry,
    });
    const token = await serializeInvocation(
      Client.invoke({
        issuer: user.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: { can: 'test/read' as const, with: 'ixo:resource:1' },
        expiration: Infinity,
        proofs: [unrelated, real],
      }),
    );

    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: [root.did],
    });
    const result = await validator.validate(token, TestRead, 'ixo:resource:1');

    expect(result.ok).toBe(true);
    expect(result.expiration).toBe(verifiedExpiry);
  });

  it('validate() rejects an expired invocation and a not-yet-valid one', async () => {
    const server = await keygen();
    const root = await keygen();
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: [root.did],
    });

    const expired = await Client.delegate({
      issuer: root.signer,
      audience: ed25519.Verifier.parse(server.did),
      capabilities: [
        { can: 'test/read' as const, with: 'ixo:resource:1' as const },
      ],
      expiration: nowSeconds() - 1,
    });
    const early = await Client.delegate({
      issuer: root.signer,
      audience: ed25519.Verifier.parse(server.did),
      capabilities: [
        { can: 'test/read' as const, with: 'ixo:resource:1' as const },
      ],
      expiration: nowSeconds() + 3600,
      notBefore: nowSeconds() + 600,
    });

    for (const token of [expired, early]) {
      const result = await validator.validate(
        await serializeDelegation(token),
        TestRead,
        'ixo:resource:1',
      );
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('UNAUTHORIZED');
    }
  });

  it('validate() accepts a token without expiry unless requireExpiration is set', async () => {
    const server = await keygen();
    const root = await keygen();
    const mint = async () =>
      serializeInvocation(
        Client.invoke({
          issuer: root.signer,
          audience: ed25519.Verifier.parse(server.did),
          capability: { can: 'test/read' as const, with: 'ixo:resource:1' },
          expiration: Infinity,
        }),
      );

    const lenient = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: [root.did],
    });
    const accepted = await lenient.validate(
      await mint(),
      TestRead,
      'ixo:resource:1',
    );
    expect(accepted.ok).toBe(true);
    expect(accepted.expiration).toBeUndefined();

    const strict = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: [root.did],
      requireExpiration: true,
    });
    const refused = await strict.validate(
      await mint(),
      TestRead,
      'ixo:resource:1',
    );
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe('UNAUTHORIZED');
  });

  it('validate() honours requireExpiration when only a proof in the verified path expires', async () => {
    const server = await keygen();
    const root = await keygen();
    const user = await keygen();
    const proofExpiry = nowSeconds() + 900;
    const grant = await Client.delegate({
      issuer: root.signer,
      audience: user.signer,
      capabilities: [
        { can: 'test/read' as const, with: 'ixo:resource:1' as const },
      ],
      expiration: proofExpiry,
    });
    const token = await serializeInvocation(
      Client.invoke({
        issuer: user.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: { can: 'test/read' as const, with: 'ixo:resource:1' },
        expiration: Infinity,
        proofs: [grant],
      }),
    );

    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: [root.did],
      requireExpiration: true,
    });
    const result = await validator.validate(token, TestRead, 'ixo:resource:1');

    expect(result.ok).toBe(true);
    expect(result.expiration).toBe(proofExpiry);
  });
});

describe('verification methods that are not Ed25519 keys', () => {
  const ixoDid = 'did:ixo:ixo1mixedkeys' as const;
  // A secp256k1 multicodec key (0xe7 0x01 + 33 bytes) is a well-formed
  // did:key but not an Ed25519 one; the second is not a multicodec key at all.
  const secp256k1Key: KeyDID = `did:key:z${base58Encode(
    new Uint8Array([0xe7, 0x01, 0x02, ...new Uint8Array(32).fill(7)]),
  )}`;
  const garbageKey: KeyDID = 'did:key:z1111';

  it('validate() skips unusable keys and verifies with the Ed25519 key', async () => {
    const server = await keygen();
    const userKey = await keygen();
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: ['*'],
      didResolver: tableResolver({
        [ixoDid]: [secp256k1Key, garbageKey, userKey.did],
      }),
    });

    const token = await serializeInvocation(
      Client.invoke({
        issuer: userKey.signer.withDID(ixoDid),
        audience: ed25519.Verifier.parse(server.did),
        capability: { can: 'test/read' as const, with: 'ixo:resource:1' },
      }),
    );
    const result = await validator.validate(token, TestRead, 'ixo:resource:1');

    expect(result.ok).toBe(true);
    expect(result.invoker).toBe(ixoDid);
  });

  it('validateDelegation() skips unusable keys and verifies with the Ed25519 key', async () => {
    const server = await keygen();
    const userKey = await keygen();
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: [],
      didResolver: tableResolver({
        [ixoDid]: [garbageKey, secp256k1Key, userKey.did],
      }),
    });

    const delegation = await Client.delegate({
      issuer: userKey.signer.withDID(ixoDid),
      audience: ed25519.Verifier.parse(server.did),
      capabilities: [{ can: '*' as const, with: 'ixo:oracle' as const }],
      expiration: nowSeconds() + 600,
    });
    const result = await validator.validateDelegation(
      await serializeDelegation(delegation),
    );

    expect(result.ok).toBe(true);
    expect(result.invoker).toBe(ixoDid);
  });

  it('still fails with INVALID_SIGNATURE when no key is usable', async () => {
    const server = await keygen();
    const userKey = await keygen();
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: [],
      didResolver: tableResolver({ [ixoDid]: [garbageKey] }),
    });

    const delegation = await Client.delegate({
      issuer: userKey.signer.withDID(ixoDid),
      audience: ed25519.Verifier.parse(server.did),
      capabilities: [{ can: '*' as const, with: 'ixo:oracle' as const }],
      expiration: nowSeconds() + 600,
    });
    const result = await validator.validateDelegation(
      await serializeDelegation(delegation),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_SIGNATURE');
  });
});

describe('malformed input', () => {
  async function validToken() {
    const server = await keygen();
    const root = await keygen();
    const token = await serializeInvocation(
      Client.invoke({
        issuer: root.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: { can: 'test/read' as const, with: 'ixo:resource:1' },
      }),
    );
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: [root.did],
    });
    return { token, validator };
  }

  it.each([
    ['an empty string', () => ''],
    ['non-base64 text', () => '%%% not base64 %%%'],
    [
      'random bytes',
      () => Buffer.from('random bytes, not a CAR').toString('base64'),
    ],
  ])(
    'rejects %s as INVALID_FORMAT in both entry points',
    async (_label, make) => {
      const { validator } = await validToken();
      const input = make();

      const invocation = await validator.validate(
        input,
        TestRead,
        'ixo:resource:1',
      );
      expect(invocation.ok).toBe(false);
      expect(invocation.error?.code).toBe('INVALID_FORMAT');

      const delegation = await validator.validateDelegation(input);
      expect(delegation.ok).toBe(false);
      expect(delegation.error?.code).toBe('INVALID_FORMAT');
    },
  );

  it('rejects a truncated CAR as INVALID_FORMAT', async () => {
    const { token, validator } = await validToken();
    const bytes = Buffer.from(token, 'base64');
    const truncated = bytes.subarray(0, Math.floor(bytes.length / 2));

    const result = await validator.validate(
      truncated.toString('base64'),
      TestRead,
      'ixo:resource:1',
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_FORMAT');

    const delegation = await validator.validateDelegation(
      truncated.toString('base64'),
    );
    expect(delegation.ok).toBe(false);
    expect(delegation.error?.code).toBe('INVALID_FORMAT');
  });

  it('a malformed attempt does not mark the real token as used', async () => {
    const { token, validator } = await validToken();
    await validator.validate('', TestRead, 'ixo:resource:1');
    const result = await validator.validate(token, TestRead, 'ixo:resource:1');
    expect(result.ok).toBe(true);
  });
});

describe('chains', () => {
  it('rejects a three-hop chain whose middle delegation is addressed to someone else', async () => {
    const server = await keygen();
    const root = await keygen();
    const alice = await keygen();
    const bob = await keygen();
    const carol = await keygen();

    const rootToAlice = await Client.delegate({
      issuer: root.signer,
      audience: alice.signer,
      capabilities: [
        { can: 'test/read' as const, with: 'ixo:resource:1' as const },
      ],
    });
    const aliceToCarol = await Client.delegate({
      issuer: alice.signer,
      audience: carol.signer,
      capabilities: [
        { can: 'test/read' as const, with: 'ixo:resource:1' as const },
      ],
      proofs: [rootToAlice],
    });
    const token = await serializeInvocation(
      Client.invoke({
        issuer: bob.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: { can: 'test/read' as const, with: 'ixo:resource:1' },
        proofs: [aliceToCarol],
      }),
    );

    for (const rootIssuers of [[root.did], ['*']]) {
      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers,
      });
      const result = await validator.validate(
        token,
        TestRead,
        'ixo:resource:1',
      );
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('UNAUTHORIZED');
    }
  });

  it('rejects a three-hop chain whose root delegation is addressed to someone else', async () => {
    const server = await keygen();
    const root = await keygen();
    const alice = await keygen();
    const bob = await keygen();
    const mallory = await keygen();

    const rootToMallory = await Client.delegate({
      issuer: root.signer,
      audience: mallory.signer,
      capabilities: [
        { can: 'test/read' as const, with: 'ixo:resource:1' as const },
      ],
    });
    const aliceToBob = await Client.delegate({
      issuer: alice.signer,
      audience: bob.signer,
      capabilities: [
        { can: 'test/read' as const, with: 'ixo:resource:1' as const },
      ],
      proofs: [rootToMallory],
    });
    const token = await serializeInvocation(
      Client.invoke({
        issuer: bob.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: { can: 'test/read' as const, with: 'ixo:resource:1' },
        proofs: [aliceToBob],
      }),
    );

    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: [root.did],
    });
    const result = await validator.validate(token, TestRead, 'ixo:resource:1');
    expect(result.ok).toBe(false);
  });

  it('reports every hop of a chain longer than a caller may expect', async () => {
    const server = await keygen();
    const parties = await Promise.all([keygen(), keygen(), keygen(), keygen()]);
    const cap = {
      can: 'test/read' as const,
      with: 'ixo:resource:1' as const,
    };

    let proof = await Client.delegate({
      issuer: parties[0]!.signer,
      audience: parties[1]!.signer,
      capabilities: [cap],
    });
    for (let i = 1; i < parties.length - 1; i++) {
      proof = await Client.delegate({
        issuer: parties[i]!.signer,
        audience: parties[i + 1]!.signer,
        capabilities: [cap],
        proofs: [proof],
      });
    }
    const invoker = parties[parties.length - 1]!;
    const token = await serializeInvocation(
      Client.invoke({
        issuer: invoker.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: cap,
        proofs: [proof],
      }),
    );

    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: ['*'],
    });
    const result = await validator.validate(token, TestRead, 'ixo:resource:1');

    expect(result.ok).toBe(true);
    expect(result.proofChain).toEqual(parties.map((p) => p.did));
    expect(result.proofChainCids).toHaveLength(parties.length);
  });

  it('validateDelegation() rejects an inner hop whose audience is not the next issuer', async () => {
    const server = await keygen();
    const root = await keygen();
    const user = await keygen();
    const other = await keygen();

    const rootToOther = await Client.delegate({
      issuer: root.signer,
      audience: other.signer,
      capabilities: [{ can: '*' as const, with: 'ixo:oracle' as const }],
      expiration: nowSeconds() + 600,
    });
    const delegation = await Client.delegate({
      issuer: user.signer,
      audience: ed25519.Verifier.parse(server.did),
      capabilities: [{ can: '*' as const, with: 'ixo:oracle' as const }],
      expiration: nowSeconds() + 600,
      proofs: [rootToOther],
    });

    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: [],
    });
    const result = await validator.validateDelegation(
      await serializeDelegation(delegation),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNAUTHORIZED');
  });
});

describe('resources', () => {
  async function delegated(
    grantWith: `ixo:${string}`,
    invokeWith: `ixo:${string}`,
  ) {
    const server = await keygen();
    const root = await keygen();
    const user = await keygen();
    const grant = await Client.delegate({
      issuer: root.signer,
      audience: user.signer,
      capabilities: [{ can: 'test/read' as const, with: grantWith }],
    });
    const token = await serializeInvocation(
      Client.invoke({
        issuer: user.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: { can: 'test/read' as const, with: invokeWith },
        proofs: [grant],
      }),
    );
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: [root.did],
    });
    return { token, validator };
  }

  it('a grant on ixo:foo does not cover ixo:foobar', async () => {
    const { token, validator } = await delegated('ixo:foo', 'ixo:foobar');
    const result = await validator.validate(token, TestRead, 'ixo:foobar');
    expect(result.ok).toBe(false);
  });

  it('an invocation on ixo:foo is not accepted for resource ixo:foobar', async () => {
    const { token, validator } = await delegated('ixo:foo', 'ixo:foo');
    const result = await validator.validate(token, TestRead, 'ixo:foobar');
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNAUTHORIZED');
  });

  it('a grant on ixo:a/* covers ixo:a/b but not ixo:ab', async () => {
    const covered = await delegated('ixo:a/*', 'ixo:a/b');
    expect(
      (await covered.validator.validate(covered.token, TestRead, 'ixo:a/b')).ok,
    ).toBe(true);

    const sibling = await delegated('ixo:a/*', 'ixo:ab');
    expect(
      (await sibling.validator.validate(sibling.token, TestRead, 'ixo:ab')).ok,
    ).toBe(false);
  });

  it('an invocation on ixo:a/* is accepted for ixo:a/x but not for ixo:ab', async () => {
    const first = await delegated('ixo:a/*', 'ixo:a/*');
    expect(
      (await first.validator.validate(first.token, TestRead, 'ixo:a/x')).ok,
    ).toBe(true);

    const second = await delegated('ixo:a/*', 'ixo:a/*');
    const refused = await second.validator.validate(
      second.token,
      TestRead,
      'ixo:ab',
    );
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe('UNAUTHORIZED');
  });
});

describe('revocation checker failure in validateDelegation()', () => {
  async function signedDelegation() {
    const server = await keygen();
    const user = await keygen();
    const delegation = await Client.delegate({
      issuer: user.signer,
      audience: ed25519.Verifier.parse(server.did),
      capabilities: [{ can: '*' as const, with: 'ixo:oracle' as const }],
      expiration: nowSeconds() + 600,
    });
    return { server, token: await serializeDelegation(delegation) };
  }

  it('fails closed by default', async () => {
    const { server, token } = await signedDelegation();
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: [],
      revocationChecker: {
        check: async () => {
          throw new Error('unreachable');
        },
      },
    });
    const result = await validator.validateDelegation(token);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('REVOCATION_CHECK_FAILED');
  });

  it('fails open when configured to', async () => {
    const { server, token } = await signedDelegation();
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: [],
      revocationFailure: 'open',
      revocationChecker: {
        check: async () => {
          throw new Error('unreachable');
        },
      },
    });
    const result = await validator.validateDelegation(token);
    expect(result.ok).toBe(true);
  });
});

describe('capability shapes the Workers runtime validates', () => {
  it('a self-issued wildcard-ability invocation reports can "*" on its resource', async () => {
    const server = await keygen();
    const userKey = await keygen();
    const userDid = 'did:ixo:ixo1shelluser' as const;
    const OracleAuth = defineCapability({ can: '*', protocol: 'ixo:' });
    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: ['*'],
      didResolver: tableResolver({ [userDid]: [userKey.did] }),
    });

    const token = await serializeInvocation(
      Client.invoke({
        issuer: userKey.signer.withDID(userDid),
        audience: ed25519.Verifier.parse(server.did),
        capability: { can: '*', with: 'ixo:oracle' },
        expiration: nowSeconds() + 300,
      }),
    );
    const result = await validator.validate(token, OracleAuth, 'ixo:oracle');

    expect(result.ok).toBe(true);
    expect(result.invoker).toBe(userDid);
    expect(result.capability).toStrictEqual({
      can: '*',
      with: 'ixo:oracle',
      nb: undefined,
    });
  });

  it('a delegated capability with declared caveats reports all of them', async () => {
    const server = await keygen();
    const user = await keygen();
    const channel = await keygen();
    const ChannelInvoke = defineCapability({
      can: 'ixo:channel/invoke',
      protocol: 'ixo:',
      supportWildcards: false,
      nb: {
        provider: Schema.string(),
        bindingRevision: Schema.integer(),
        oracleDid: Schema.string(),
      },
      derives: (claimed, delegated) =>
        claimed.nb?.provider === delegated.nb?.provider &&
        claimed.nb?.bindingRevision === delegated.nb?.bindingRevision &&
        claimed.nb?.oracleDid === delegated.nb?.oracleDid
          ? { ok: {} }
          : { error: new Error('caveats cannot change') },
    });
    const nb = {
      provider: 'whatsapp',
      bindingRevision: 3,
      oracleDid: server.did,
    };
    const grant = await Client.delegate({
      issuer: user.signer,
      audience: channel.signer,
      capabilities: [
        {
          can: 'ixo:channel/invoke' as const,
          with: 'ixo:channel:b1' as const,
          nb,
        },
      ],
      expiration: nowSeconds() + 300,
    });
    const token = await serializeInvocation(
      Client.invoke({
        issuer: channel.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'ixo:channel/invoke' as const,
          with: 'ixo:channel:b1' as const,
          nb,
        },
        expiration: nowSeconds() + 60,
        proofs: [grant],
      }),
    );

    const validator = await createUCANValidator({
      serverDid: server.did,
      rootIssuers: ['*'],
      requireExpiration: true,
    });
    const result = await validator.validate(
      token,
      ChannelInvoke,
      'ixo:channel:b1',
    );

    expect(result.ok).toBe(true);
    expect(result.proofChain).toEqual([user.did, channel.did]);
    expect(result.capability).toStrictEqual({
      can: 'ixo:channel/invoke',
      with: 'ixo:channel:b1',
      nb,
    });
  });
});

import { describe, expect, it } from 'vitest';
import * as Client from '@ucanto/client';
import { ed25519 } from '@ucanto/principal';
import { createUCANValidator } from './validator.js';
import { defineCapability, Schema } from '../capabilities/capability.js';
import {
  createDelegation,
  createInvocation,
  getDelegationCid,
  serializeDelegation,
  serializeInvocation,
  type Capability,
} from '../client/create-client.js';
import { InMemoryRevocationStore } from '../store/revocation.js';

/**
 * Helper: generate an ed25519 keypair
 */
async function keygen() {
  const signer = await ed25519.Signer.generate();
  return { signer, did: signer.did() };
}

/**
 * Simple capability without caveats
 */
const TestRead = defineCapability({
  can: 'test/read',
  protocol: 'ixo:',
});

/**
 * Capability with limit caveat
 */
const EmployeesRead = defineCapability({
  can: 'employees/read',
  protocol: 'myapp:',
  nb: { limit: Schema.integer().optional() },
  derives: (claimed, delegated) => {
    const claimedLimit = claimed.nb?.limit ?? Infinity;
    const delegatedLimit = delegated.nb?.limit ?? Infinity;
    if (claimedLimit > delegatedLimit) {
      return {
        error: new Error(
          `Cannot request limit=${claimedLimit}, delegation only allows limit=${delegatedLimit}`,
        ),
      };
    }
    return { ok: {} };
  },
});

describe('UCAN Validator', () => {
  describe('proofChain', () => {
    it('should return single-element chain for direct root invocation', async () => {
      const server = await keygen();
      const root = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: [root.did],
      });

      const invocation = Client.invoke({
        issuer: root.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'test/read' as const,
          with: `ixo:resource:123` as const,
        },
        proofs: [],
      });

      const serialized = await serializeInvocation(invocation);
      const result = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(true);
      expect(result.proofChain).toEqual([root.did]);
    });

    it('should return two-element chain for root -> user delegation', async () => {
      const server = await keygen();
      const root = await keygen();
      const user = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: [root.did],
      });

      const delegation = await Client.delegate({
        issuer: root.signer,
        audience: user.signer,
        capabilities: [
          {
            can: 'test/read' as const,
            with: 'ixo:resource:123' as const,
          },
        ],
      });

      const invocation = Client.invoke({
        issuer: user.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'test/read' as const,
          with: 'ixo:resource:123' as const,
        },
        proofs: [delegation],
      });

      const serialized = await serializeInvocation(invocation);
      const result = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(true);
      expect(result.proofChain).toEqual([root.did, user.did]);
    });

    it('should return three-element chain for root -> alice -> bob', async () => {
      const server = await keygen();
      const root = await keygen();
      const alice = await keygen();
      const bob = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: [root.did],
      });

      const rootToAlice = await Client.delegate({
        issuer: root.signer,
        audience: alice.signer,
        capabilities: [
          {
            can: 'test/read' as const,
            with: 'ixo:resource:123' as const,
          },
        ],
      });

      const aliceToBob = await Client.delegate({
        issuer: alice.signer,
        audience: bob.signer,
        capabilities: [
          {
            can: 'test/read' as const,
            with: 'ixo:resource:123' as const,
          },
        ],
        proofs: [rootToAlice],
      });

      const invocation = Client.invoke({
        issuer: bob.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'test/read' as const,
          with: 'ixo:resource:123' as const,
        },
        proofs: [aliceToBob],
      });

      const serialized = await serializeInvocation(invocation);
      const result = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(true);
      expect(result.proofChain).toEqual([root.did, alice.did, bob.did]);
    });
  });

  describe('expiration', () => {
    it('should return undefined expiration when no expiration is set (Infinity)', async () => {
      const server = await keygen();
      const root = await keygen();
      const user = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: [root.did],
      });

      // Using createDelegation/createInvocation which default to Infinity
      const delegation = await createDelegation({
        issuer: root.signer,
        audience: user.did,
        capabilities: [
          {
            can: 'test/read' as Capability['can'],
            with: 'ixo:resource:123' as Capability['with'],
          },
        ],
      });

      const invocation = await createInvocation({
        issuer: user.signer,
        audience: server.did,
        capability: {
          can: 'test/read' as Capability['can'],
          with: 'ixo:resource:123' as Capability['with'],
        },
        proofs: [delegation],
      });

      const serialized = await serializeInvocation(invocation);
      const result = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(true);
      // No expiration set → defaults to Infinity → filtered out
      expect(result.expiration).toBeUndefined();
    });

    it('should return delegation expiration when set', async () => {
      const server = await keygen();
      const root = await keygen();
      const user = await keygen();

      const futureExp = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: [root.did],
      });

      const delegation = await Client.delegate({
        issuer: root.signer,
        audience: user.signer,
        capabilities: [
          {
            can: 'test/read' as const,
            with: 'ixo:resource:123' as const,
          },
        ],
        expiration: futureExp,
      });

      const invocation = Client.invoke({
        issuer: user.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'test/read' as const,
          with: 'ixo:resource:123' as const,
        },
        proofs: [delegation],
      });

      const serialized = await serializeInvocation(invocation);
      const result = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(true);
      expect(result.expiration).toBeDefined();
      expect(result.expiration).toBeLessThanOrEqual(futureExp);
    });

    it('should return earliest expiration across the chain', async () => {
      const server = await keygen();
      const root = await keygen();
      const alice = await keygen();
      const bob = await keygen();

      const laterExp = Math.floor(Date.now() / 1000) + 7200; // 2 hours
      const earlierExp = Math.floor(Date.now() / 1000) + 3600; // 1 hour

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: [root.did],
      });

      // Root -> Alice with later expiration
      const rootToAlice = await Client.delegate({
        issuer: root.signer,
        audience: alice.signer,
        capabilities: [
          {
            can: 'test/read' as const,
            with: 'ixo:resource:123' as const,
          },
        ],
        expiration: laterExp,
      });

      // Alice -> Bob with earlier expiration
      const aliceToBob = await Client.delegate({
        issuer: alice.signer,
        audience: bob.signer,
        capabilities: [
          {
            can: 'test/read' as const,
            with: 'ixo:resource:123' as const,
          },
        ],
        expiration: earlierExp,
        proofs: [rootToAlice],
      });

      const invocation = Client.invoke({
        issuer: bob.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'test/read' as const,
          with: 'ixo:resource:123' as const,
        },
        proofs: [aliceToBob],
      });

      const serialized = await serializeInvocation(invocation);
      const result = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(true);
      expect(result.expiration).toBeDefined();
      // Should be the earlier expiration (alice->bob's 1 hour, not root->alice's 2 hours)
      expect(result.expiration).toBeLessThanOrEqual(earlierExp);
    });
  });

  describe('validation failures', () => {
    it('should reject malformed base64 input', async () => {
      const server = await keygen();
      const root = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: [root.did],
      });

      const result = await validator.validate(
        'not-valid-base64!!!',
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('INVALID_FORMAT');
    });

    it('should reject invocation with wrong audience', async () => {
      const server = await keygen();
      const wrongServer = await keygen();
      const root = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: [root.did],
      });

      // Invocation addressed to wrong server
      const invocation = Client.invoke({
        issuer: root.signer,
        audience: ed25519.Verifier.parse(wrongServer.did),
        capability: {
          can: 'test/read' as const,
          with: 'ixo:resource:123' as const,
        },
        proofs: [],
      });

      const serialized = await serializeInvocation(invocation);
      const result = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('UNAUTHORIZED');
    });

    it('should reject invocation with untrusted root', async () => {
      const server = await keygen();
      const trustedRoot = await keygen();
      const untrustedRoot = await keygen();
      const user = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: [trustedRoot.did], // Only trustedRoot is trusted
      });

      // Delegation from untrusted root
      const delegation = await Client.delegate({
        issuer: untrustedRoot.signer,
        audience: user.signer,
        capabilities: [
          {
            can: 'test/read' as const,
            with: 'ixo:resource:123' as const,
          },
        ],
      });

      const invocation = Client.invoke({
        issuer: user.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'test/read' as const,
          with: 'ixo:resource:123' as const,
        },
        proofs: [delegation],
      });

      const serialized = await serializeInvocation(invocation);
      const result = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('UNAUTHORIZED');
    });

    it('should reject invocation with mismatched resource', async () => {
      const server = await keygen();
      const root = await keygen();
      const user = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: [root.did],
      });

      const delegation = await Client.delegate({
        issuer: root.signer,
        audience: user.signer,
        capabilities: [
          {
            can: 'test/read' as const,
            with: 'ixo:resource:123' as const,
          },
        ],
      });

      const invocation = Client.invoke({
        issuer: user.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'test/read' as const,
          with: 'ixo:resource:123' as const,
        },
        proofs: [delegation],
      });

      const serialized = await serializeInvocation(invocation);
      // Validate against a different resource than what was delegated
      const result = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:999',
      );

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('UNAUTHORIZED');
    });
  });

  describe('caveat validation', () => {
    it('should pass when caveats are within bounds', async () => {
      const server = await keygen();
      const root = await keygen();
      const user = await keygen();

      const resource = `myapp:${server.did}` as const;

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: [root.did],
      });

      const delegation = await Client.delegate({
        issuer: root.signer,
        audience: user.signer,
        capabilities: [
          {
            can: 'employees/read' as const,
            with: resource,
            nb: { limit: 50 },
          },
        ],
      });

      const invocation = Client.invoke({
        issuer: user.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'employees/read' as const,
          with: resource,
          nb: { limit: 25 },
        },
        proofs: [delegation],
      });

      const serialized = await serializeInvocation(invocation);
      const result = await validator.validate(
        serialized,
        EmployeesRead,
        resource,
      );

      expect(result.ok).toBe(true);
      expect(result.capability?.nb?.limit).toBe(25);
    });

    it('should reject when caveats exceed delegated bounds', async () => {
      const server = await keygen();
      const root = await keygen();
      const user = await keygen();

      const resource = `myapp:${server.did}` as const;

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: [root.did],
      });

      const delegation = await Client.delegate({
        issuer: root.signer,
        audience: user.signer,
        capabilities: [
          {
            can: 'employees/read' as const,
            with: resource,
            nb: { limit: 25 },
          },
        ],
      });

      // User tries to exceed their limit
      const invocation = Client.invoke({
        issuer: user.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'employees/read' as const,
          with: resource,
          nb: { limit: 100 },
        },
        proofs: [delegation],
      });

      const serialized = await serializeInvocation(invocation);
      const result = await validator.validate(
        serialized,
        EmployeesRead,
        resource,
      );

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('CAVEAT_VIOLATION');
    });
  });

  describe('facts', () => {
    it('should return facts attached to the invocation', async () => {
      const server = await keygen();
      const root = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: [root.did],
      });

      const facts = [
        { verified: true, timestamp: 1234567890 },
        { service: 'oracle', version: '1.0' },
      ];

      const invocation = Client.invoke({
        issuer: root.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'test/read' as const,
          with: 'ixo:resource:123' as const,
        },
        facts,
        proofs: [],
      });

      const serialized = await serializeInvocation(invocation);
      const result = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(true);
      expect(result.facts).toBeDefined();
      expect(result.facts).toHaveLength(2);
      expect(result.facts).toEqual(facts);
    });

    it('should return undefined facts when none are attached', async () => {
      const server = await keygen();
      const root = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: [root.did],
      });

      const invocation = Client.invoke({
        issuer: root.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'test/read' as const,
          with: 'ixo:resource:123' as const,
        },
        proofs: [],
      });

      const serialized = await serializeInvocation(invocation);
      const result = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(true);
      expect(result.facts).toBeUndefined();
    });

    it('should pass facts through createInvocation helper', async () => {
      const server = await keygen();
      const root = await keygen();
      const user = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: [root.did],
      });

      const facts = [{ requestId: 'abc-123', origin: 'portal' }];

      const delegation = await createDelegation({
        issuer: root.signer,
        audience: user.did,
        capabilities: [
          {
            can: 'test/read' as Capability['can'],
            with: 'ixo:resource:123' as Capability['with'],
          },
        ],
      });

      const invocation = await createInvocation({
        issuer: user.signer,
        audience: server.did,
        capability: {
          can: 'test/read' as Capability['can'],
          with: 'ixo:resource:123' as Capability['with'],
        },
        proofs: [delegation],
        facts,
      });

      const serialized = await serializeInvocation(invocation);
      const result = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(true);
      expect(result.facts).toEqual(facts);
    });

    it('should pass facts through createDelegation helper', async () => {
      const server = await keygen();
      const root = await keygen();
      const user = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: [root.did],
      });

      const delegationFacts = [{ purpose: 'oracle-access', level: 'standard' }];

      const delegation = await createDelegation({
        issuer: root.signer,
        audience: user.did,
        capabilities: [
          {
            can: 'test/read' as Capability['can'],
            with: 'ixo:resource:123' as Capability['with'],
          },
        ],
        facts: delegationFacts,
      });

      // Verify facts are on the delegation itself
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((delegation as any).facts).toEqual(delegationFacts);

      // Invocation without facts — facts on delegation don't propagate to result
      const invocation = await createInvocation({
        issuer: user.signer,
        audience: server.did,
        capability: {
          can: 'test/read' as Capability['can'],
          with: 'ixo:resource:123' as Capability['with'],
        },
        proofs: [delegation],
      });

      const serialized = await serializeInvocation(invocation);
      const result = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(true);
      // Result facts come from the invocation, not the delegation
      expect(result.facts).toBeUndefined();
    });
  });

  describe('replay protection', () => {
    it('should reject replayed invocations', async () => {
      const server = await keygen();
      const root = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: [root.did],
      });

      const invocation = Client.invoke({
        issuer: root.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'test/read' as const,
          with: 'ixo:resource:123' as const,
        },
        proofs: [],
      });

      const serialized = await serializeInvocation(invocation);

      // First validation should pass
      const result1 = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );
      expect(result1.ok).toBe(true);

      // Second validation (replay) should fail
      const result2 = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );
      expect(result2.ok).toBe(false);
      expect(result2.error?.code).toBe('REPLAY');
    });
  });

  // ---------------------------------------------------------------------------
  // SECURITY — wildcard root issuers (`rootIssuers: ['*']`, i.e. "accept any
  // root"). A naive '*' implementation makes canIssue() return true for the
  // INVOKER, so ucanto treats every invocation as self-issued and never walks
  // or verifies the attached delegation proofs — yet buildProofChain() reads
  // proofs[0] blindly and callers trust proofChain[0] as the root (row owner).
  // That let an attacker forge a delegation naming any victim as root and have
  // the request attributed to that victim (identity-theft IDOR). These tests
  // pin the fix: wildcard mode must still cryptographically verify the whole
  // chain (signatures + attenuation) up to the claimed root.
  // ---------------------------------------------------------------------------
  describe('wildcard root issuers (security)', () => {
    it('accepts a self-issued invocation (no proofs) and roots it at the invoker', async () => {
      const server = await keygen();
      const user = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: ['*'],
      });

      const invocation = Client.invoke({
        issuer: user.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'test/read' as const,
          with: 'ixo:resource:123' as const,
        },
        proofs: [],
      });

      const serialized = await serializeInvocation(invocation);
      const result = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(true);
      expect(result.proofChain).toEqual([user.did]);
    });

    it('accepts a legitimately delegated invocation and roots it at the real root', async () => {
      const server = await keygen();
      const root = await keygen();
      const user = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: ['*'],
      });

      const delegation = await Client.delegate({
        issuer: root.signer,
        audience: user.signer,
        capabilities: [
          {
            can: 'test/read' as const,
            with: 'ixo:resource:123' as const,
          },
        ],
      });

      const invocation = Client.invoke({
        issuer: user.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'test/read' as const,
          with: 'ixo:resource:123' as const,
        },
        proofs: [delegation],
      });

      const serialized = await serializeInvocation(invocation);
      const result = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(true);
      expect(result.proofChain).toEqual([root.did, user.did]);
    });

    it('REJECTS an invocation carrying a FORGED delegation proof (attacker signs as victim)', async () => {
      const server = await keygen();
      const victim = await keygen();
      const attacker = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: ['*'],
      });

      // The attacker forges a delegation that CLAIMS to come from the victim
      // but is signed with the attacker's OWN key (victim never signed it).
      const forgedProof = await Client.delegate({
        issuer: attacker.signer.withDID(victim.did),
        audience: attacker.signer,
        capabilities: [
          {
            can: 'test/read' as const,
            with: 'ixo:resource:123' as const,
          },
        ],
      });

      const invocation = Client.invoke({
        issuer: attacker.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'test/read' as const,
          with: 'ixo:resource:123' as const,
        },
        proofs: [forgedProof],
      });

      const serialized = await serializeInvocation(invocation);
      const result = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(false);
      // And crucially, the request is NOT attributed to the victim.
      expect(result.proofChain).toBeUndefined();
      expect(result.invoker).toBeUndefined();
    });

    it('REJECTS a forged proof naming an unresolvable (never-registered) victim DID', async () => {
      const server = await keygen();
      const attacker = await keygen();
      const victimDid = 'did:ixo:victimNeverRegistered000' as const;

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: ['*'],
        // No resolver entry for the victim — it cannot be resolved to a key.
        didResolver: async (did) => ({
          error: { name: 'NotFound', did, message: `Unknown DID: ${did}` },
        }),
      });

      const forgedProof = await Client.delegate({
        issuer: attacker.signer.withDID(victimDid),
        audience: attacker.signer,
        capabilities: [
          {
            can: 'test/read' as const,
            with: 'ixo:resource:123' as const,
          },
        ],
      });

      const invocation = Client.invoke({
        issuer: attacker.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'test/read' as const,
          with: 'ixo:resource:123' as const,
        },
        proofs: [forgedProof],
      });

      const serialized = await serializeInvocation(invocation);
      const result = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(false);
      expect(result.proofChain).toBeUndefined();
    });

    it('REJECTS a broken proof chain (proof audience is not the invoker)', async () => {
      const server = await keygen();
      const root = await keygen();
      const user = await keygen();
      const unrelated = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: ['*'],
      });

      // Root delegated to `unrelated`, but `user` tries to invoke with it.
      const rootToUnrelated = await Client.delegate({
        issuer: root.signer,
        audience: unrelated.signer,
        capabilities: [
          {
            can: 'test/read' as const,
            with: 'ixo:resource:123' as const,
          },
        ],
      });

      const invocation = Client.invoke({
        issuer: user.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'test/read' as const,
          with: 'ixo:resource:123' as const,
        },
        proofs: [rootToUnrelated],
      });

      const serialized = await serializeInvocation(invocation);
      const result = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(false);
    });

    it('ENFORCES caveat attenuation across the chain (invoker cannot exceed delegated limit)', async () => {
      const server = await keygen();
      const root = await keygen();
      const user = await keygen();

      const resource = `myapp:${server.did}` as const;

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: ['*'],
      });

      // Root delegates limit=25 to user.
      const delegation = await Client.delegate({
        issuer: root.signer,
        audience: user.signer,
        capabilities: [
          {
            can: 'employees/read' as const,
            with: resource,
            nb: { limit: 25 },
          },
        ],
      });

      // User invokes with limit=100 (exceeds the delegated 25).
      const invocation = Client.invoke({
        issuer: user.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'employees/read' as const,
          with: resource,
          nb: { limit: 100 },
        },
        proofs: [delegation],
      });

      const serialized = await serializeInvocation(invocation);
      const result = await validator.validate(
        serialized,
        EmployeesRead,
        resource,
      );

      expect(result.ok).toBe(false);
    });

    it('accepts a did:ixo-rooted delegated invocation under wildcard (resolver equivalence)', async () => {
      const server = await keygen();
      const rootKey = await keygen();
      const user = await keygen();
      const ixoRoot = 'did:ixo:ixo1wildcardroot' as const;
      const ixoRootSigner = rootKey.signer.withDID(ixoRoot);

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: ['*'],
        didResolver: async (did) => {
          if (did === ixoRoot) return { ok: [rootKey.did] };
          return { error: { name: 'NotFound', did, message: 'Unknown DID' } };
        },
      });

      const delegation = await Client.delegate({
        issuer: ixoRootSigner,
        audience: user.signer,
        capabilities: [
          {
            can: 'test/read' as const,
            with: 'ixo:resource:123' as const,
          },
        ],
      });

      const invocation = Client.invoke({
        issuer: user.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'test/read' as const,
          with: 'ixo:resource:123' as const,
        },
        proofs: [delegation],
      });

      const serialized = await serializeInvocation(invocation);
      const result = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(true);
      expect(result.proofChain).toEqual([ixoRoot, user.did]);
    });

    it('does NOT surface a forged proof as root even when the resource embeds the invoker DID', async () => {
      // Regression for the resource-scoped self-issue short-circuit: when
      // `cap.with` contains the invoker DID, ucanto authorizes on the
      // invocation alone and never walks the stapled proofs — so proofChain
      // must be derived from the VERIFIED authorization, not the raw proofs,
      // or a forged victim would be reported as the row-owning root.
      const server = await keygen();
      const victim = await keygen();
      const attacker = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: ['*'],
      });

      // The resource names the ATTACKER's own DID (self-owned resource).
      const resource = `ixo:${attacker.did}` as const;

      const forgedProof = await Client.delegate({
        issuer: attacker.signer.withDID(victim.did),
        audience: attacker.signer,
        capabilities: [{ can: 'test/read' as const, with: resource }],
      });

      const invocation = Client.invoke({
        issuer: attacker.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: { can: 'test/read' as const, with: resource },
        proofs: [forgedProof],
      });

      const serialized = await serializeInvocation(invocation);
      const result = await validator.validate(serialized, TestRead, resource);

      // The attacker owns their own resource, so the invocation authorizes —
      // but rooted at the ATTACKER, never the forged victim.
      expect(result.ok).toBe(true);
      expect(result.proofChain).toEqual([attacker.did]);
      expect(result.proofChain).not.toContain(victim.did);
    });

    it('REJECTS a forged proof naming a RESOLVABLE did:ixo victim (real key ≠ attacker key)', async () => {
      const server = await keygen();
      const victimKey = await keygen(); // the victim's REAL registered key
      const attacker = await keygen();
      const victimDid = 'did:ixo:ixo1realvictim' as const;

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: ['*'],
        didResolver: async (did) => {
          if (did === victimDid) return { ok: [victimKey.did] };
          return { error: { name: 'NotFound', did, message: 'Unknown DID' } };
        },
      });

      // Attacker forges a delegation CLAIMING to be the did:ixo victim but
      // signs it with the attacker's own key (not the victim's real key).
      const forgedProof = await Client.delegate({
        issuer: attacker.signer.withDID(victimDid),
        audience: attacker.signer,
        capabilities: [
          { can: 'test/read' as const, with: 'ixo:resource:123' as const },
        ],
      });

      const invocation = Client.invoke({
        issuer: attacker.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'test/read' as const,
          with: 'ixo:resource:123' as const,
        },
        proofs: [forgedProof],
      });

      const serialized = await serializeInvocation(invocation);
      const result = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(false);
      expect(result.proofChain).toBeUndefined();
      expect(result.invoker).toBeUndefined();
    });

    it('REJECTS a self-issued invocation forged as another did:key identity (invalid invocation signature)', async () => {
      const server = await keygen();
      const victim = await keygen();
      const attacker = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: ['*'],
      });

      // Attacker mints an invocation CLAIMING issuer = victim (no proofs) but
      // signs with their own key. structuralRoot === the (claimed) invoker, so
      // canIssue would accept it — but ucanto still verifies the invocation's
      // signature against the victim's key, which fails.
      const invocation = Client.invoke({
        issuer: attacker.signer.withDID(victim.did),
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'test/read' as const,
          with: 'ixo:resource:123' as const,
        },
        proofs: [],
      });

      const serialized = await serializeInvocation(invocation);
      const result = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(false);
      expect(result.invoker).toBeUndefined();
    });

    it('REJECTS a self-issued invocation forged as a resolvable did:ixo identity', async () => {
      const server = await keygen();
      const victimKey = await keygen();
      const attacker = await keygen();
      const victimDid = 'did:ixo:ixo1victimselfissue' as const;

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: ['*'],
        didResolver: async (did) => {
          if (did === victimDid) return { ok: [victimKey.did] };
          return { error: { name: 'NotFound', did, message: 'Unknown DID' } };
        },
      });

      const invocation = Client.invoke({
        issuer: attacker.signer.withDID(victimDid),
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'test/read' as const,
          with: 'ixo:resource:123' as const,
        },
        proofs: [],
      });

      const serialized = await serializeInvocation(invocation);
      const result = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(false);
    });

    it('REJECTS a 3-hop chain whose middle delegation is forged', async () => {
      const server = await keygen();
      const root = await keygen();
      const alice = await keygen();
      const bob = await keygen();
      const attacker = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: ['*'],
      });

      // Legit: root -> alice
      const rootToAlice = await Client.delegate({
        issuer: root.signer,
        audience: alice.signer,
        capabilities: [
          { can: 'test/read' as const, with: 'ixo:resource:123' as const },
        ],
      });

      // FORGED middle link: CLAIMS alice -> bob but is signed by attacker.
      const forgedAliceToBob = await Client.delegate({
        issuer: attacker.signer.withDID(alice.did),
        audience: bob.signer,
        capabilities: [
          { can: 'test/read' as const, with: 'ixo:resource:123' as const },
        ],
        proofs: [rootToAlice],
      });

      const invocation = Client.invoke({
        issuer: bob.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'test/read' as const,
          with: 'ixo:resource:123' as const,
        },
        proofs: [forgedAliceToBob],
      });

      const serialized = await serializeInvocation(invocation);
      const result = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(false);
    });

    it('accepts a legit 3-hop delegation under wildcard and roots it correctly', async () => {
      const server = await keygen();
      const root = await keygen();
      const alice = await keygen();
      const bob = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: ['*'],
      });

      const rootToAlice = await Client.delegate({
        issuer: root.signer,
        audience: alice.signer,
        capabilities: [
          { can: 'test/read' as const, with: 'ixo:resource:123' as const },
        ],
      });
      const aliceToBob = await Client.delegate({
        issuer: alice.signer,
        audience: bob.signer,
        capabilities: [
          { can: 'test/read' as const, with: 'ixo:resource:123' as const },
        ],
        proofs: [rootToAlice],
      });
      const invocation = Client.invoke({
        issuer: bob.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'test/read' as const,
          with: 'ixo:resource:123' as const,
        },
        proofs: [aliceToBob],
      });

      const serialized = await serializeInvocation(invocation);
      const result = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(true);
      expect(result.proofChain).toEqual([root.did, alice.did, bob.did]);
    });

    it('REJECTS a wildcard invocation whose delegation has expired', async () => {
      const server = await keygen();
      const root = await keygen();
      const user = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: ['*'],
      });

      const expiredDelegation = await Client.delegate({
        issuer: root.signer,
        audience: user.signer,
        capabilities: [
          { can: 'test/read' as const, with: 'ixo:resource:123' as const },
        ],
        expiration: Math.floor(Date.now() / 1000) - 60, // expired a minute ago
      });

      const invocation = Client.invoke({
        issuer: user.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'test/read' as const,
          with: 'ixo:resource:123' as const,
        },
        proofs: [expiredDelegation],
      });

      const serialized = await serializeInvocation(invocation);
      const result = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(false);
    });

    it('REJECTS replay of a delegated invocation under wildcard', async () => {
      const server = await keygen();
      const root = await keygen();
      const user = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: ['*'],
      });

      const delegation = await Client.delegate({
        issuer: root.signer,
        audience: user.signer,
        capabilities: [
          { can: 'test/read' as const, with: 'ixo:resource:123' as const },
        ],
      });
      const invocation = Client.invoke({
        issuer: user.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'test/read' as const,
          with: 'ixo:resource:123' as const,
        },
        proofs: [delegation],
      });

      const serialized = await serializeInvocation(invocation);
      const first = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );
      expect(first.ok).toBe(true);
      expect(first.proofChain).toEqual([root.did, user.did]);

      const second = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );
      expect(second.ok).toBe(false);
      expect(second.error?.code).toBe('REPLAY');
    });

    it('does not let a self-issuer bypass verification by stapling an unrelated proof', async () => {
      const server = await keygen();
      const user = await keygen();
      const other = await keygen();
      const someoneElse = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: ['*'],
      });

      // A real, correctly-signed delegation — but NOT addressed to `user`.
      const unrelated = await Client.delegate({
        issuer: other.signer,
        audience: someoneElse.signer,
        capabilities: [
          { can: 'test/read' as const, with: 'ixo:resource:123' as const },
        ],
      });

      // `user` staples the unrelated proof onto a self-issued invocation.
      const invocation = Client.invoke({
        issuer: user.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'test/read' as const,
          with: 'ixo:resource:123' as const,
        },
        proofs: [unrelated],
      });

      const serialized = await serializeInvocation(invocation);
      const result = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );

      // Fail-closed: the stapled proof does not chain to `user`, and `user` is
      // not the structural root, so authorization is refused rather than
      // mis-attributed to `other`.
      expect(result.ok).toBe(false);
      expect(result.proofChain).toBeUndefined();
    });

    it('accepts a delegated invocation whose did:ixo root publishes multiple keys', async () => {
      const server = await keygen();
      const rootKeyA = await keygen();
      const rootKeyB = await keygen();
      const user = await keygen();
      const ixoRoot = 'did:ixo:ixo1multikey' as const;
      // The root delegation is signed with the SECOND published key.
      const ixoRootSigner = rootKeyB.signer.withDID(ixoRoot);

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: ['*'],
        didResolver: async (did) => {
          if (did === ixoRoot) return { ok: [rootKeyA.did, rootKeyB.did] };
          return { error: { name: 'NotFound', did, message: 'Unknown DID' } };
        },
      });

      const delegation = await Client.delegate({
        issuer: ixoRootSigner,
        audience: user.signer,
        capabilities: [
          { can: 'test/read' as const, with: 'ixo:resource:123' as const },
        ],
      });
      const invocation = Client.invoke({
        issuer: user.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'test/read' as const,
          with: 'ixo:resource:123' as const,
        },
        proofs: [delegation],
      });

      const serialized = await serializeInvocation(invocation);
      const result = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(true);
      expect(result.proofChain).toEqual([ixoRoot, user.did]);
    });

    it('treats wildcard combined with explicit root DIDs as wildcard', async () => {
      const server = await keygen();
      const root = await keygen();
      const user = await keygen();
      const someExplicitDid = (await keygen()).did;

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: ['*', someExplicitDid],
      });

      const delegation = await Client.delegate({
        issuer: root.signer,
        audience: user.signer,
        capabilities: [
          { can: 'test/read' as const, with: 'ixo:resource:123' as const },
        ],
      });
      const invocation = Client.invoke({
        issuer: user.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'test/read' as const,
          with: 'ixo:resource:123' as const,
        },
        proofs: [delegation],
      });

      const serialized = await serializeInvocation(invocation);
      const result = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(true);
      expect(result.proofChain).toEqual([root.did, user.did]);
    });
  });

  describe('validateDelegation', () => {
    it('should validate a simple delegation with did:key', async () => {
      const server = await keygen();
      const user = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: [user.did],
      });

      const delegation = await createDelegation({
        issuer: user.signer,
        audience: server.did,
        capabilities: [
          {
            can: '*' as Capability['can'],
            with: 'ixo:oracle' as Capability['with'],
          },
        ],
        expiration: Math.floor(Date.now() / 1000) + 3600,
      });

      const serialized = await serializeDelegation(delegation);
      const result = await validator.validateDelegation(serialized);

      expect(result.ok).toBe(true);
      expect(result.invoker).toBe(user.did);
      expect(result.capability?.can).toBe('*');
      expect(result.capability?.with).toBe('ixo:oracle');
      expect(result.proofChain).toEqual([user.did]);
    });

    it('should validate a delegation with non-did:key issuer (withDID)', async () => {
      const server = await keygen();
      const userKey = await keygen();
      // Simulate a did:ixo issuer (signer with overridden DID)
      const ixoDid = 'did:ixo:ixo1testuser123' as const;
      const signer = userKey.signer.withDID(ixoDid);

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: [ixoDid],
        // Provide a resolver that maps did:ixo -> did:key
        didResolver: async (did) => {
          if (did === ixoDid) return { ok: [userKey.did] };
          return { error: { name: 'NotFound', did, message: 'Unknown DID' } };
        },
      });

      const delegation = await createDelegation({
        issuer: signer,
        audience: server.did,
        capabilities: [
          {
            can: '*' as Capability['can'],
            with: 'ixo:oracle' as Capability['with'],
          },
        ],
        expiration: Math.floor(Date.now() / 1000) + 3600,
      });

      const serialized = await serializeDelegation(delegation);
      const result = await validator.validateDelegation(serialized);

      expect(result.ok).toBe(true);
      expect(result.invoker).toBe(ixoDid);
      expect(result.proofChain).toEqual([ixoDid]);
    });

    it('should reject delegation with wrong audience', async () => {
      const server = await keygen();
      const wrongServer = await keygen();
      const user = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: [user.did],
      });

      const delegation = await createDelegation({
        issuer: user.signer,
        audience: wrongServer.did,
        capabilities: [
          {
            can: '*' as Capability['can'],
            with: 'ixo:oracle' as Capability['with'],
          },
        ],
      });

      const serialized = await serializeDelegation(delegation);
      const result = await validator.validateDelegation(serialized);

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('UNAUTHORIZED');
    });

    it('should reject expired delegation', async () => {
      const server = await keygen();
      const user = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: [user.did],
      });

      const delegation = await createDelegation({
        issuer: user.signer,
        audience: server.did,
        capabilities: [
          {
            can: '*' as Capability['can'],
            with: 'ixo:oracle' as Capability['with'],
          },
        ],
        expiration: Math.floor(Date.now() / 1000) - 60, // expired 1 minute ago
      });

      const serialized = await serializeDelegation(delegation);
      const result = await validator.validateDelegation(serialized);

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('EXPIRED');
    });

    it('should reject delegation with tampered signature', async () => {
      const server = await keygen();
      const user = await keygen();
      const attacker = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: [user.did],
      });

      // Attacker creates delegation pretending to be user
      // but signing with their own key (signature won't match user's DID)
      const delegation = await createDelegation({
        issuer: attacker.signer.withDID(user.did),
        audience: server.did,
        capabilities: [
          {
            can: '*' as Capability['can'],
            with: 'ixo:oracle' as Capability['with'],
          },
        ],
        expiration: Math.floor(Date.now() / 1000) + 3600,
      });

      const serialized = await serializeDelegation(delegation);
      const result = await validator.validateDelegation(serialized);

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('INVALID_SIGNATURE');
    });

    it('should reject malformed base64 input', async () => {
      const server = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: [],
      });

      const result = await validator.validateDelegation('not-valid-base64!!!');

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('INVALID_FORMAT');
    });

    it('should validate delegation chain (root -> user -> server)', async () => {
      const server = await keygen();
      const root = await keygen();
      const user = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: [root.did],
      });

      // Root delegates to user
      const rootToUser = await Client.delegate({
        issuer: root.signer,
        audience: user.signer,
        capabilities: [
          {
            can: '*' as const,
            with: 'ixo:oracle' as const,
          },
        ],
        expiration: Math.floor(Date.now() / 1000) + 7200,
      });

      // User re-delegates to server (with proof of root delegation)
      const userToServer = await createDelegation({
        issuer: user.signer,
        audience: server.did,
        capabilities: [
          {
            can: '*' as Capability['can'],
            with: 'ixo:oracle' as Capability['with'],
          },
        ],
        expiration: Math.floor(Date.now() / 1000) + 3600,
        proofs: [rootToUser],
      });

      const serialized = await serializeDelegation(userToServer);
      const result = await validator.validateDelegation(serialized);

      expect(result.ok).toBe(true);
      expect(result.invoker).toBe(user.did);
      expect(result.proofChain).toEqual([root.did, user.did]);
    });

    it('should return effective expiration across delegation chain', async () => {
      const server = await keygen();
      const root = await keygen();
      const user = await keygen();

      const laterExp = Math.floor(Date.now() / 1000) + 7200; // 2 hours
      const earlierExp = Math.floor(Date.now() / 1000) + 3600; // 1 hour

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: [root.did],
      });

      // Root -> user with later expiration
      const rootToUser = await Client.delegate({
        issuer: root.signer,
        audience: user.signer,
        capabilities: [
          {
            can: '*' as const,
            with: 'ixo:oracle' as const,
          },
        ],
        expiration: laterExp,
      });

      // User -> server with earlier expiration
      const userToServer = await createDelegation({
        issuer: user.signer,
        audience: server.did,
        capabilities: [
          {
            can: '*' as Capability['can'],
            with: 'ixo:oracle' as Capability['with'],
          },
        ],
        expiration: earlierExp,
        proofs: [rootToUser],
      });

      const serialized = await serializeDelegation(userToServer);
      const result = await validator.validateDelegation(serialized);

      expect(result.ok).toBe(true);
      expect(result.expiration).toBeDefined();
      expect(result.expiration).toBeLessThanOrEqual(earlierExp);
    });

    it('should reject delegation with broken proof chain', async () => {
      const server = await keygen();
      const root = await keygen();
      const user = await keygen();
      const unrelated = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: [root.did],
      });

      // Root delegates to an unrelated party (not user)
      const rootToUnrelated = await Client.delegate({
        issuer: root.signer,
        audience: unrelated.signer,
        capabilities: [
          {
            can: '*' as const,
            with: 'ixo:oracle' as const,
          },
        ],
      });

      // User tries to use unrelated's delegation as proof (audience mismatch)
      const userToServer = await createDelegation({
        issuer: user.signer,
        audience: server.did,
        capabilities: [
          {
            can: '*' as Capability['can'],
            with: 'ixo:oracle' as Capability['with'],
          },
        ],
        proofs: [rootToUnrelated],
      });

      const serialized = await serializeDelegation(userToServer);
      const result = await validator.validateDelegation(serialized);

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('UNAUTHORIZED');
    });

    it('should return undefined expiration for non-expiring delegation', async () => {
      const server = await keygen();
      const user = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: [user.did],
      });

      const delegation = await createDelegation({
        issuer: user.signer,
        audience: server.did,
        capabilities: [
          {
            can: '*' as Capability['can'],
            with: 'ixo:oracle' as Capability['with'],
          },
        ],
        // No expiration = Infinity = no effective expiration
      });

      const serialized = await serializeDelegation(delegation);
      const result = await validator.validateDelegation(serialized);

      expect(result.ok).toBe(true);
      expect(result.expiration).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Revocation. A UCAN revocation targets the canonical CID of one exact
  // delegation and is irreversible, so validation must check EVERY delegation
  // in the cryptographically verified proof chain (plus the invocation itself)
  // against the revocation set — in a single batched call.
  // ---------------------------------------------------------------------------
  describe('revocation', () => {
    /** Build a root -> alice -> bob chain and the invocation bob presents. */
    async function threeHopChain() {
      const server = await keygen();
      const root = await keygen();
      const alice = await keygen();
      const bob = await keygen();

      const rootToAlice = await Client.delegate({
        issuer: root.signer,
        audience: alice.signer,
        capabilities: [
          { can: 'test/read' as const, with: 'ixo:resource:123' as const },
        ],
      });

      const aliceToBob = await Client.delegate({
        issuer: alice.signer,
        audience: bob.signer,
        capabilities: [
          { can: 'test/read' as const, with: 'ixo:resource:123' as const },
        ],
        proofs: [rootToAlice],
      });

      const invocation = Client.invoke({
        issuer: bob.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'test/read' as const,
          with: 'ixo:resource:123' as const,
        },
        proofs: [aliceToBob],
      });

      const serialized = await serializeInvocation(invocation);

      return {
        server,
        root,
        alice,
        bob,
        rootToAlice,
        aliceToBob,
        serialized,
        invocationCid: await getDelegationCid(serialized),
      };
    }

    it('reports the canonical CIDs of the verified chain, parents first', async () => {
      const chain = await threeHopChain();

      const validator = await createUCANValidator({
        serverDid: chain.server.did,
        rootIssuers: [chain.root.did],
      });

      const result = await validator.validate(
        chain.serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(true);
      expect(result.proofChainCids).toEqual([
        chain.rootToAlice.cid.toString(),
        chain.aliceToBob.cid.toString(),
        chain.invocationCid,
      ]);
    });

    it('rejects when the ROOT delegation in the chain is revoked', async () => {
      const chain = await threeHopChain();

      const validator = await createUCANValidator({
        serverDid: chain.server.did,
        rootIssuers: [chain.root.did],
        revocationChecker: new InMemoryRevocationStore([
          chain.rootToAlice.cid.toString(),
        ]),
      });

      const result = await validator.validate(
        chain.serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('REVOKED');
      expect(result.error?.message).toContain(chain.rootToAlice.cid.toString());
    });

    it('rejects when an INTERMEDIATE delegation in the chain is revoked', async () => {
      const chain = await threeHopChain();

      const validator = await createUCANValidator({
        serverDid: chain.server.did,
        rootIssuers: [chain.root.did],
        revocationChecker: new InMemoryRevocationStore([
          chain.aliceToBob.cid.toString(),
        ]),
      });

      const result = await validator.validate(
        chain.serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('REVOKED');
      expect(result.error?.message).toContain(chain.aliceToBob.cid.toString());
    });

    it('rejects when the INVOCATION itself is revoked', async () => {
      const chain = await threeHopChain();

      const validator = await createUCANValidator({
        serverDid: chain.server.did,
        rootIssuers: [chain.root.did],
        revocationChecker: new InMemoryRevocationStore([chain.invocationCid]),
      });

      const result = await validator.validate(
        chain.serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('REVOKED');
    });

    it('accepts a chain with no revoked links', async () => {
      const chain = await threeHopChain();

      const validator = await createUCANValidator({
        serverDid: chain.server.did,
        rootIssuers: [chain.root.did],
        // A revocation of an unrelated delegation must not affect this chain.
        revocationChecker: new InMemoryRevocationStore([
          'bafyreiunrelateddelegationcidthatisnotinthischain',
        ]),
      });

      const result = await validator.validate(
        chain.serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(true);
    });

    it('checks the whole chain in ONE batched call', async () => {
      const chain = await threeHopChain();
      const calls: string[][] = [];

      const validator = await createUCANValidator({
        serverDid: chain.server.did,
        rootIssuers: [chain.root.did],
        revocationChecker: {
          check: async (cids) => {
            calls.push(cids);
            return [];
          },
        },
      });

      const result = await validator.validate(
        chain.serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual([
        chain.rootToAlice.cid.toString(),
        chain.aliceToBob.cid.toString(),
        chain.invocationCid,
      ]);
    });

    it('fails CLOSED by default when the checker itself fails', async () => {
      const chain = await threeHopChain();

      const validator = await createUCANValidator({
        serverDid: chain.server.did,
        rootIssuers: [chain.root.did],
        revocationChecker: {
          check: async () => {
            throw new Error('store unreachable');
          },
        },
      });

      const result = await validator.validate(
        chain.serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('REVOCATION_CHECK_FAILED');
      expect(result.error?.message).toContain('store unreachable');
    });

    it('fails OPEN when configured to', async () => {
      const chain = await threeHopChain();

      const validator = await createUCANValidator({
        serverDid: chain.server.did,
        rootIssuers: [chain.root.did],
        revocationFailure: 'open',
        revocationChecker: {
          check: async () => {
            throw new Error('store unreachable');
          },
        },
      });

      const result = await validator.validate(
        chain.serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(true);
    });

    it('does not burn the replay slot when the revocation check fails', async () => {
      const chain = await threeHopChain();
      let failNext = true;

      const validator = await createUCANValidator({
        serverDid: chain.server.did,
        rootIssuers: [chain.root.did],
        revocationChecker: {
          check: async () => {
            if (failNext) {
              failNext = false;
              throw new Error('transient outage');
            }
            return [];
          },
        },
      });

      // Transient failure -> rejected, and the invocation must remain usable.
      const first = await validator.validate(
        chain.serialized,
        TestRead,
        'ixo:resource:123',
      );
      expect(first.error?.code).toBe('REVOCATION_CHECK_FAILED');

      // The client retries the SAME invocation once the store recovers.
      const retry = await validator.validate(
        chain.serialized,
        TestRead,
        'ixo:resource:123',
      );
      expect(retry.ok).toBe(true);

      // ...and normal replay protection still applies afterwards.
      const replay = await validator.validate(
        chain.serialized,
        TestRead,
        'ixo:resource:123',
      );
      expect(replay.error?.code).toBe('REPLAY');
    });

    it('performs no revocation checking when no checker is configured', async () => {
      const chain = await threeHopChain();

      const validator = await createUCANValidator({
        serverDid: chain.server.did,
        rootIssuers: [chain.root.did],
      });

      const result = await validator.validate(
        chain.serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(true);
      expect(result.proofChainCids).toHaveLength(3);
    });

    it('is inert without a checker even under fail-closed config — upgrading alone changes nothing', async () => {
      // BACKWARD COMPATIBILITY. revocationFailure defaults to 'closed', but that policy only
      // applies to a checker that FAILED. With no checker configured there is nothing to fail, so
      // a service that bumps the package without opting in must behave exactly as before.
      const chain = await threeHopChain();

      const validator = await createUCANValidator({
        serverDid: chain.server.did,
        rootIssuers: [chain.root.did],
        // Explicitly fail-closed, and still no checker.
        revocationFailure: 'closed',
      });

      const result = await validator.validate(
        chain.serialized,
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('is inert without a checker in validateDelegation() too', async () => {
      const server = await keygen();
      const user = await keygen();

      const delegation = await createDelegation({
        issuer: user.signer,
        audience: server.did,
        capabilities: [
          {
            can: '*' as Capability['can'],
            with: 'ixo:oracle' as Capability['with'],
          },
        ],
        expiration: Math.floor(Date.now() / 1000) + 3600,
      });

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: [],
        revocationFailure: 'closed',
      });

      const result = await validator.validateDelegation(
        await serializeDelegation(delegation),
      );

      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('rejects a revoked delegation in validateDelegation()', async () => {
      const server = await keygen();
      const user = await keygen();

      const delegation = await createDelegation({
        issuer: user.signer,
        audience: server.did,
        capabilities: [
          {
            can: '*' as Capability['can'],
            with: 'ixo:oracle' as Capability['with'],
          },
        ],
        expiration: Math.floor(Date.now() / 1000) + 3600,
      });
      const serialized = await serializeDelegation(delegation);

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: [],
        revocationChecker: new InMemoryRevocationStore([
          delegation.cid.toString(),
        ]),
      });

      const result = await validator.validateDelegation(serialized);

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('REVOKED');
    });

    // -------------------------------------------------------------------------
    // Padding resistance. A revocation check is only as good as the CID set it
    // is given. If that set came from the RAW stapled proofs, an attacker could
    // pad a token with cheap unverifiable decoys until the genuinely revoked
    // delegation fell outside whatever window the checker looked at. These pin
    // that the set comes from ucanto's VERIFIED authorization instead, which
    // an attacker cannot inflate: a decoy that does not verify never enters it.
    // -------------------------------------------------------------------------
    it('cannot be padded: forged decoy proofs never enter the checked CID set', async () => {
      const server = await keygen();
      const root = await keygen();
      const attacker = await keygen();
      const victim = await keygen();

      // A genuine grant the attacker really holds — this is the one that gets revoked.
      const realGrant = await Client.delegate({
        issuer: root.signer,
        audience: attacker.signer,
        capabilities: [
          { can: 'test/read' as const, with: 'ixo:resource:123' as const },
        ],
      });

      // 40 forged proofs claiming to come from the victim (attacker signs them).
      const decoyCids: string[] = [];
      const decoys = [];
      for (let i = 0; i < 40; i++) {
        const decoy = await Client.delegate({
          issuer: attacker.signer.withDID(victim.did),
          audience: attacker.signer,
          capabilities: [
            { can: 'test/read' as const, with: 'ixo:resource:123' as const },
          ],
          facts: [{ nonce: `decoy-${i}` }],
        });
        decoys.push(decoy);
        decoyCids.push(decoy.cid.toString());
      }

      const invocation = Client.invoke({
        issuer: attacker.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'test/read' as const,
          with: 'ixo:resource:123' as const,
        },
        proofs: [realGrant, ...decoys],
      });
      const serialized = await serializeInvocation(invocation);

      const seen: string[][] = [];
      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: ['*'],
        revocationChecker: {
          check: async (cids) => {
            seen.push(cids);
            return cids.includes(realGrant.cid.toString())
              ? [realGrant.cid.toString()]
              : [];
          },
        },
      });

      const result = await validator.validate(
        serialized,
        TestRead,
        'ixo:resource:123',
      );

      // The revoked grant is caught despite 40 decoys stapled alongside it.
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('REVOKED');

      // The checker saw ONLY the verified chain — the decoys never diluted it.
      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual([
        realGrant.cid.toString(),
        await getDelegationCid(serialized),
      ]);
      for (const decoyCid of decoyCids) {
        expect(seen[0]).not.toContain(decoyCid);
      }
    });

    it('never attributes a padded invocation to the forged victim', async () => {
      const server = await keygen();
      const root = await keygen();
      const attacker = await keygen();
      const victim = await keygen();

      const realGrant = await Client.delegate({
        issuer: root.signer,
        audience: attacker.signer,
        capabilities: [
          { can: 'test/read' as const, with: 'ixo:resource:123' as const },
        ],
      });
      const forged = await Client.delegate({
        issuer: attacker.signer.withDID(victim.did),
        audience: attacker.signer,
        capabilities: [
          { can: 'test/read' as const, with: 'ixo:resource:123' as const },
        ],
      });

      const invocation = Client.invoke({
        issuer: attacker.signer,
        audience: ed25519.Verifier.parse(server.did),
        capability: {
          can: 'test/read' as const,
          with: 'ixo:resource:123' as const,
        },
        proofs: [realGrant, forged],
      });

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: ['*'],
      });
      const result = await validator.validate(
        await serializeInvocation(invocation),
        TestRead,
        'ixo:resource:123',
      );

      // Authorized on the genuine grant only; the victim never appears.
      expect(result.ok).toBe(true);
      expect(result.proofChain).toEqual([root.did, attacker.did]);
      expect(result.proofChain).not.toContain(victim.did);
      expect(result.proofChainCids).not.toContain(forged.cid.toString());
    });

    it('accepts an unrevoked delegation in validateDelegation() and reports its cid', async () => {
      const server = await keygen();
      const user = await keygen();

      const delegation = await createDelegation({
        issuer: user.signer,
        audience: server.did,
        capabilities: [
          {
            can: '*' as Capability['can'],
            with: 'ixo:oracle' as Capability['with'],
          },
        ],
        expiration: Math.floor(Date.now() / 1000) + 3600,
      });
      const serialized = await serializeDelegation(delegation);

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: [],
        revocationChecker: new InMemoryRevocationStore(),
      });

      const result = await validator.validateDelegation(serialized);

      expect(result.ok).toBe(true);
      expect(result.proofChainCids).toEqual([delegation.cid.toString()]);
    });
  });

  // ---------------------------------------------------------------------------
  // requireExpiration — a never-expiring token can only ever be neutralized by
  // a revocation record that must then be kept forever, so production
  // validators should refuse unbounded expiry.
  // ---------------------------------------------------------------------------
  describe('requireExpiration', () => {
    it('rejects an invocation with unbounded expiry', async () => {
      const server = await keygen();
      const user = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: ['*'],
        requireExpiration: true,
      });

      const invocation = await createInvocation({
        issuer: user.signer,
        audience: server.did,
        capability: {
          can: 'test/read' as Capability['can'],
          with: 'ixo:resource:123' as Capability['with'],
        },
        // no expiration => Infinity
      });

      const result = await validator.validate(
        await serializeInvocation(invocation),
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('UNAUTHORIZED');
      expect(result.error?.message).toContain('bounded expiry');
    });

    it('accepts an invocation with a bounded expiry', async () => {
      const server = await keygen();
      const user = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: ['*'],
        requireExpiration: true,
      });

      const invocation = await createInvocation({
        issuer: user.signer,
        audience: server.did,
        capability: {
          can: 'test/read' as Capability['can'],
          with: 'ixo:resource:123' as Capability['with'],
        },
        expiration: Math.floor(Date.now() / 1000) + 300,
      });

      const result = await validator.validate(
        await serializeInvocation(invocation),
        TestRead,
        'ixo:resource:123',
      );

      expect(result.ok).toBe(true);
    });

    it('rejects a delegation with unbounded expiry in validateDelegation()', async () => {
      const server = await keygen();
      const user = await keygen();

      const validator = await createUCANValidator({
        serverDid: server.did,
        rootIssuers: [],
        requireExpiration: true,
      });

      const delegation = await createDelegation({
        issuer: user.signer,
        audience: server.did,
        capabilities: [
          {
            can: '*' as Capability['can'],
            with: 'ixo:oracle' as Capability['with'],
          },
        ],
      });

      const result = await validator.validateDelegation(
        await serializeDelegation(delegation),
      );

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('UNAUTHORIZED');
    });
  });
});

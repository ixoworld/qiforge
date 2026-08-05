/**
 * @fileoverview Tests for the capability-proof verifier.
 *
 * The property throughout: a validly-signed token proves what it says, and
 * nothing adjacent to it. Most of these assert that a real token for the
 * wrong thing is refused, because that is the failure a verifier exists to
 * catch — an invalid token is caught by the UCAN package before this code
 * runs.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createCapabilityVerifier,
  type DelegationValidator,
} from './ucan-adapter.js';

const PROOF = 'base64-car-delegation';
const EXPECTATION = {
  subject: 'did:ixo:entity:test',
  object: 'ixo:memory/episodes',
  action: 'memory_search',
  value: null,
};

function validator(
  result: Awaited<ReturnType<DelegationValidator['validateDelegation']>>,
): DelegationValidator {
  return { validateDelegation: async () => result };
}

const valid = (
  capability = { can: 'memory_search', with: 'ixo:memory/episodes' },
) => validator({ ok: true, invoker: 'did:key:alice', capability });

describe('a token that does not validate', () => {
  it('is refused, carrying the reason the validator gave', async () => {
    const verify = createCapabilityVerifier({
      validator: validator({
        ok: false,
        error: { code: 'EXPIRED', message: 'expired at ...' },
      }),
    });
    const verdict = await verify(PROOF, EXPECTATION);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toContain('EXPIRED');
  });

  it('is refused when validation throws rather than returning', async () => {
    const verify = createCapabilityVerifier({
      validator: {
        validateDelegation: () => Promise.reject(new Error('resolver down')),
      },
    });
    const verdict = await verify(PROOF, EXPECTATION);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toContain('resolver down');
  });

  it('is refused when it carries no capability to check', async () => {
    const verify = createCapabilityVerifier({
      validator: validator({ ok: true, invoker: 'did:key:alice' }),
    });
    expect((await verify(PROOF, EXPECTATION)).valid).toBe(false);
  });
});

// The check that makes the verifier worth having. Everything above is the
// UCAN package's job; this is not.
describe('a valid token for something else', () => {
  it('is refused when it covers a different resource', async () => {
    const verify = createCapabilityVerifier({
      validator: valid({ can: 'memory_search', with: 'ixo:treasury' }),
    });
    const verdict = await verify(PROOF, EXPECTATION);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toContain('ixo:treasury');
  });

  it('is refused when it permits a different ability', async () => {
    const verify = createCapabilityVerifier({
      validator: valid({ can: 'memory_delete', with: 'ixo:memory/episodes' }),
    });
    const verdict = await verify(PROOF, EXPECTATION);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toContain('memory_delete');
  });

  // A prefix is not a namespace. `ixo:vendor:approved` must not cover
  // `ixo:vendor:approved-not-really`, which is why the separator is required.
  it('is refused when the resource merely shares a prefix', async () => {
    const verify = createCapabilityVerifier({
      validator: valid({ can: '*', with: 'ixo:memory' }),
    });
    const verdict = await verify(PROOF, {
      ...EXPECTATION,
      object: 'ixo:memory-of-someone-else',
    });
    expect(verdict.valid).toBe(false);
  });
});

describe('a valid token for this action', () => {
  it('is accepted on an exact match', async () => {
    const verify = createCapabilityVerifier({ validator: valid() });
    expect((await verify(PROOF, EXPECTATION)).valid).toBe(true);
  });

  it('is accepted when the resource wildcard covers the object', async () => {
    const verify = createCapabilityVerifier({
      validator: valid({ can: 'memory_search', with: 'ixo:memory/*' }),
    });
    expect((await verify(PROOF, EXPECTATION)).valid).toBe(true);
  });

  it('is accepted when the ability wildcard covers the operation', async () => {
    const verify = createCapabilityVerifier({
      validator: valid({ can: 'memory/*', with: 'ixo:memory/episodes' }),
    });
    expect(
      (await verify(PROOF, { ...EXPECTATION, action: 'memory/read' })).valid,
    ).toBe(true);
  });

  // Delegating everything is a thing a principal may deliberately do.
  it('honours a bare wildcard on both', async () => {
    const verify = createCapabilityVerifier({
      validator: valid({ can: '*', with: '*' }),
    });
    expect((await verify(PROOF, EXPECTATION)).valid).toBe(true);
  });

  it('addresses the proof by digest, never by its bytes', async () => {
    const verify = createCapabilityVerifier({ validator: valid() });
    const verdict = await verify(PROOF, EXPECTATION);
    expect(verdict.proofDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verdict.proofDigest).not.toContain(PROOF);
  });
});

// The weakest link, and the reason it is a tri-state rather than a boolean:
// a record saying a proof was unrevoked when nothing ever asked claims more
// than the runtime knows.
describe('revocation', () => {
  it('reports null — not checked — when nothing can answer', async () => {
    const verify = createCapabilityVerifier({ validator: valid() });
    const verdict = await verify(PROOF, EXPECTATION);
    expect(verdict.valid).toBe(true);
    expect(verdict.revoked).toBeNull();
  });

  it('reports false once a source confirms it', async () => {
    const verify = createCapabilityVerifier({
      validator: valid(),
      isRevoked: async () => false,
    });
    const verdict = await verify(PROOF, EXPECTATION);
    expect(verdict.revoked).toBe(false);
  });

  it('refuses a revoked proof', async () => {
    const verify = createCapabilityVerifier({
      validator: valid(),
      isRevoked: async () => true,
    });
    const verdict = await verify(PROOF, EXPECTATION);
    expect(verdict.valid).toBe(false);
    expect(verdict.revoked).toBe(true);
  });

  it('passes the digest and invoker to the revocation source', async () => {
    const isRevoked = vi.fn().mockResolvedValue(false);
    const verify = createCapabilityVerifier({ validator: valid(), isRevoked });
    await verify(PROOF, EXPECTATION);
    expect(isRevoked).toHaveBeenCalledWith(
      expect.stringMatching(/^sha256:/),
      'did:key:alice',
    );
  });

  // Unlike an absent source, something was supposed to answer and did not.
  // That is a reason to stop, not to proceed noting the gap.
  it('refuses when the revocation check itself fails', async () => {
    const verify = createCapabilityVerifier({
      validator: valid(),
      isRevoked: () => Promise.reject(new Error('status list unreachable')),
    });
    const verdict = await verify(PROOF, EXPECTATION);
    expect(verdict.valid).toBe(false);
    expect(verdict.revoked).toBeNull();
    expect(verdict.reason).toContain('status list unreachable');
  });
});

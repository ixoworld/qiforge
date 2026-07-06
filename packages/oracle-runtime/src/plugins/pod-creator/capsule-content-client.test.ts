import { describe, expect, it, vi } from 'vitest';
import type { RuntimeContext } from '../../plugin-api/types.js';
import { makeRuntimeContext } from '../../registries/test-fixtures.js';
import {
  CapsuleContentClient,
  type CapsuleContentFetcher,
  type CapsuleFetchContext,
} from './capsule-content-client.js';

const SKILL_MD = '# Service Architect\n\nDesign the POD service structure.';

/** A RuntimeContext whose UCAN resolve/mint behaviour is fully controlled. */
function ucanCtx(parts: {
  resolveServiceDid: RuntimeContext['ucan']['resolveServiceDid'];
  mintInvocation: RuntimeContext['ucan']['mintInvocation'];
}): RuntimeContext {
  return makeRuntimeContext({
    ucan: {
      hasCapability: () => true,
      requireCapability: () => undefined,
      mintInvocation: parts.mintInvocation,
      resolveServiceDid: parts.resolveServiceDid,
      hasSigningKey: () => true,
      createInvocationFromDelegation: async () => ({
        invocation: 'mock-invocation-car',
      }),
    },
  });
}

describe('CapsuleContentClient', () => {
  it('returns the fetched SKILL.md and caches it per thread', async () => {
    const fetcher = vi.fn(
      async (_name: string, _ctx: CapsuleFetchContext) => SKILL_MD,
    );
    const client = new CapsuleContentClient({ fetcher, network: 'testnet' });
    const rt = makeRuntimeContext();

    const first = await client.getSkillMarkdown(
      'design-pod-service-architect',
      rt,
    );
    const second = await client.getSkillMarkdown(
      'design-pod-service-architect',
      rt,
    );

    expect(first).toBe(SKILL_MD);
    expect(second).toBe(SKILL_MD);
    // Second call is served from the per-thread cache.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('forwards a minted ixo:skills invocation as the Authorization header', async () => {
    const resolveServiceDid = vi.fn(
      async () => 'did:web:capsules.skills.ixo.earth',
    );
    const mintInvocation = vi.fn(async () => 'capsule-token');
    let seen: Record<string, string> = {};
    const fetcher: CapsuleContentFetcher = async (_name, ctx) => {
      seen = ctx.headers;
      return SKILL_MD;
    };
    const client = new CapsuleContentClient({ fetcher, network: 'mainnet' });

    await client.getSkillMarkdown(
      'design-pod-claims-architect',
      ucanCtx({ resolveServiceDid, mintInvocation }),
    );

    expect(mintInvocation).toHaveBeenCalledWith({
      did: 'did:web:capsules.skills.ixo.earth',
      capability: 'ixo:skills',
    });
    expect(seen.Authorization).toBe('Bearer capsule-token');
    expect(seen['X-Auth-Type']).toBe('ucan');
    expect(seen['X-IXO-Network']).toBe('mainnet');
  });

  it('degrades to public-only headers when no invocation can be minted', async () => {
    let seen: Record<string, string> = {};
    const fetcher: CapsuleContentFetcher = async (_name, ctx) => {
      seen = ctx.headers;
      return SKILL_MD;
    };
    const client = new CapsuleContentClient({ fetcher, network: 'testnet' });

    const text = await client.getSkillMarkdown(
      'design-pod-flow-builder',
      ucanCtx({
        resolveServiceDid: async () => null,
        mintInvocation: vi.fn(async () => 'unused'),
      }),
    );

    expect(text).toBe(SKILL_MD);
    expect(seen.Authorization).toBeUndefined();
    expect(seen['X-Auth-Type']).toBeUndefined();
    expect(seen['X-IXO-Network']).toBe('testnet');
  });

  it('throws a descriptive error when no fetcher is configured', async () => {
    const client = new CapsuleContentClient();
    await expect(
      client.getSkillMarkdown('design-pod-demo-builder', makeRuntimeContext()),
    ).rejects.toThrow(/no content fetcher configured/);
  });
});

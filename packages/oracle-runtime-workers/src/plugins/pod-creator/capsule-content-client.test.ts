import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeRuntimeContext } from '../../core/test-fixtures';
import type { RuntimeContext } from '../../plugin-api/types';
import {
  CAPSULE_FAILURE_TTL_MS,
  CapsuleContentClient,
  MAX_CAPSULE_INSTRUCTIONS_BYTES,
  createRegistryInstructionsFetcher,
  type CapsuleContentFetcher,
  type CapsuleFetchContext,
} from './capsule-content-client';

const SKILL_MD = '# Service Architect\n\nDesign the POD service structure.';

/** A RuntimeContext whose UCAN resolve/mint behaviour is fully controlled. */
function ucanCtx(parts: {
  resolveServiceDid: RuntimeContext['ucan']['resolveServiceDid'];
  mintInvocation: RuntimeContext['ucan']['mintInvocation'];
}): RuntimeContext {
  const base = makeRuntimeContext();
  return {
    ...base,
    ucan: {
      ...base.ucan,
      hasSigningKey: () => true,
      mintInvocation: parts.mintInvocation,
      resolveServiceDid: parts.resolveServiceDid,
    },
  };
}

describe('CapsuleContentClient', () => {
  it('returns the fetched SKILL.md and caches it by capsule name across threads and users', async () => {
    const fetcher = vi.fn(
      async (_name: string, _ctx: CapsuleFetchContext) => SKILL_MD,
    );
    const client = new CapsuleContentClient({ fetcher, network: 'testnet' });
    const alice = makeRuntimeContext();
    const bob = makeRuntimeContext({
      user: { ...alice.user, did: 'did:ixo:user2' },
      session: { ...alice.session, id: 'session-2' },
    });

    expect(
      await client.getSkillMarkdown('design-pod-service-architect', alice),
    ).toBe(SKILL_MD);
    expect(
      await client.getSkillMarkdown('design-pod-service-architect', bob),
    ).toBe(SKILL_MD);
    // The registry serves public content only, so one entry serves everyone.
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

    // The claimed ability is the one a user's registry grant carries.
    expect(mintInvocation).toHaveBeenCalledWith(
      { did: 'did:web:capsules.skills.ixo.earth', capability: 'ixo:skills' },
      { can: 'skills/*' },
    );
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

  it('without a fetcher answers undefined at once: no DID resolution, no mint, no log', async () => {
    const resolveServiceDid = vi.fn(async () => 'did:web:capsules.example');
    const mintInvocation = vi.fn(async () => 'token');
    const warn = vi.fn();
    const base = ucanCtx({ resolveServiceDid, mintInvocation });
    const rt: RuntimeContext = {
      ...base,
      logger: { log: vi.fn(), error: vi.fn(), warn },
    };
    const client = new CapsuleContentClient();

    expect(
      await client.getSkillMarkdown('design-pod-demo-builder', rt),
    ).toBeUndefined();
    expect(resolveServiceDid).not.toHaveBeenCalled();
    expect(mintInvocation).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('remembers a failure for a short window: one request and one warn line, then a retry after it', async () => {
    let t = 0;
    const fetcher = vi
      .fn<CapsuleContentFetcher>()
      .mockRejectedValueOnce(new Error('registry answered 404'))
      .mockResolvedValueOnce(SKILL_MD);
    const warn = vi.fn();
    const client = new CapsuleContentClient({ fetcher, now: () => t });
    const base = makeRuntimeContext();
    const rt: RuntimeContext = {
      ...base,
      logger: { log: vi.fn(), error: vi.fn(), warn },
    };

    for (let turn = 0; turn < 5; turn++) {
      expect(
        await client.getSkillMarkdown('design-pod-demo-builder', rt),
      ).toBeUndefined();
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      'design-pod-demo-builder',
    );

    t += CAPSULE_FAILURE_TTL_MS;
    expect(await client.getSkillMarkdown('design-pod-demo-builder', rt)).toBe(
      SKILL_MD,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not remember a failure caused by the turn being aborted', async () => {
    const turn = new AbortController();
    const fetcher = vi
      .fn<CapsuleContentFetcher>()
      .mockImplementationOnce(async () => {
        turn.abort();
        throw new Error('aborted');
      })
      .mockResolvedValueOnce(SKILL_MD);
    const client = new CapsuleContentClient({ fetcher });
    const aborted = makeRuntimeContext({ abortSignal: turn.signal });

    expect(
      await client.getSkillMarkdown('design-pod-demo-builder', aborted),
    ).toBeUndefined();
    expect(
      await client.getSkillMarkdown(
        'design-pod-demo-builder',
        makeRuntimeContext(),
      ),
    ).toBe(SKILL_MD);
  });
});

describe('createRegistryInstructionsFetcher', () => {
  const ctx = (
    over: Partial<CapsuleFetchContext> = {},
  ): CapsuleFetchContext => ({
    baseUrl: 'https://capsules.example',
    network: 'testnet',
    headers: { 'X-IXO-Network': 'testnet', Authorization: 'Bearer tok' },
    ...over,
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GETs /skills/{name}/instructions with the registry headers and returns the markdown', async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), headers: new Headers(init?.headers) });
        return new Response(SKILL_MD, {
          status: 200,
          headers: { 'content-type': 'text/markdown' },
        });
      },
    );

    const text = await createRegistryInstructionsFetcher()(
      'design-pod-service-architect',
      ctx(),
    );

    expect(text).toBe(SKILL_MD);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://capsules.example/skills/design-pod-service-architect/instructions',
    );
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer tok');
    expect(calls[0]?.headers.get('x-ixo-network')).toBe('testnet');
  });

  it('fails on a non-2xx answer (an unpublished capsule is a 404)', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 }),
    );
    await expect(
      createRegistryInstructionsFetcher()('design-pod-demo-builder', ctx()),
    ).rejects.toThrow(/answered 404/);
  });

  it('fails on an empty body', async () => {
    vi.stubGlobal('fetch', async () => new Response('  \n', { status: 200 }));
    await expect(
      createRegistryInstructionsFetcher()('design-pod-demo-builder', ctx()),
    ).rejects.toThrow(/empty instructions/);
  });

  it('gives up after the timeout', async () => {
    vi.stubGlobal(
      'fetch',
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted by the deadline')),
          );
        }),
    );
    await expect(
      createRegistryInstructionsFetcher({ timeoutMs: 20 })(
        'design-pod-demo-builder',
        ctx(),
      ),
    ).rejects.toThrow('aborted by the deadline');
  });

  it("follows the turn's abort signal", async () => {
    let seenSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          seenSignal = init?.signal ?? undefined;
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('turn aborted')),
          );
        }),
    );
    const turn = new AbortController();
    const pending = createRegistryInstructionsFetcher()(
      'design-pod-demo-builder',
      ctx({ signal: turn.signal }),
    );
    turn.abort();
    await expect(pending).rejects.toThrow('turn aborted');
    expect(seenSignal?.aborted).toBe(true);
  });

  it('refuses a name the registry would reject, without a request', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(
      createRegistryInstructionsFetcher()('../admin', ctx()),
    ).rejects.toThrow(/not a valid registry skill name/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a body larger than the cap, by declared length', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response('x', {
          status: 200,
          headers: {
            'content-length': String(MAX_CAPSULE_INSTRUCTIONS_BYTES + 1),
          },
        }),
    );
    await expect(
      createRegistryInstructionsFetcher()('design-pod-demo-builder', ctx()),
    ).rejects.toThrow(/exceed/);
  });

  it('refuses a body larger than the cap when streamed without a length', async () => {
    const chunk = new Uint8Array(16 * 1024).fill(0x61);
    vi.stubGlobal('fetch', async () => {
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= 5) {
            controller.close();
            return;
          }
          sent += 1;
          controller.enqueue(chunk);
        },
      });
      return new Response(body, { status: 200 });
    });
    await expect(
      createRegistryInstructionsFetcher()('design-pod-demo-builder', ctx()),
    ).rejects.toThrow(/exceed/);
  });

  it('accepts a body at the cap', async () => {
    const text = 'a'.repeat(MAX_CAPSULE_INSTRUCTIONS_BYTES);
    vi.stubGlobal('fetch', async () => new Response(text, { status: 200 }));
    expect(
      await createRegistryInstructionsFetcher()(
        'design-pod-demo-builder',
        ctx(),
      ),
    ).toHaveLength(MAX_CAPSULE_INSTRUCTIONS_BYTES);
  });
});

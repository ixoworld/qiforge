/**
 * Regression coverage for `WorkersUcanService.createInvocationFromDelegation`
 * audience resolution: plugins that already resolved a service DID (memory,
 * composio via `mintInvocationSafely`) pass the DID itself as the target —
 * the service must mint straight to it. A DID is not a fetchable URL
 * (`new URL('did:web:x').origin` is `"null"`), so routing it through the
 * did.json lookup silently killed every plugin mint.
 */
import {
  createDelegation,
  serializeDelegation,
  signerFromMnemonic,
} from '@ixo/ucan';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from '@langchain/langgraph';
import { buildLoadCapabilityTool } from '../core/meta-tools';
import { ManifestRegistry, ToolRegistry } from '../core/registries';
import { createNoopAmbient } from '../core/runtime-context';
import {
  makeBuildCtx,
  makeManifest,
  makePlugin,
  makeRunConfig,
  makeRuntimeContext,
  makeTool,
} from '../core/test-fixtures';
import { adminToolCapability } from '../plugin-api/tool-plane';
import { createUcanAdapter } from './ambient';
import { resolveTurnDelegation, WorkersUcanService } from './ucan-service';

// Deterministic BIP39 test vector — never a real account.
const ORACLE_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const USER_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const ORACLE_DID = 'did:ixo:entity:testoracle0000000000000001';
const USER_DID = 'did:ixo:entity:testuser000000000000000001';
const SERVICE_DID = 'did:web:memory.example.com';

async function userDelegationCar(
  expiration = Math.floor(Date.now() / 1000) + 3600,
): Promise<string> {
  const { signer } = await signerFromMnemonic(
    USER_MNEMONIC,
    USER_DID as `did:ixo:${string}`,
  );
  const delegation = await createDelegation({
    issuer: signer,
    audience: ORACLE_DID,
    capabilities: [{ can: 'memory/*', with: 'ixo:memory' }],
    expiration,
  });
  return serializeDelegation(delegation);
}

describe('WorkersUcanService.createInvocationFromDelegation', () => {
  const fetchSpy = vi.fn<typeof fetch>();
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    fetchSpy.mockReset();
    globalThis.fetch = fetchSpy;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function service(): WorkersUcanService {
    return new WorkersUcanService({
      oracleDid: ORACLE_DID,
      signingMnemonic: ORACLE_MNEMONIC,
    });
  }

  it('mints straight to a did: target without any did.json fetch', async () => {
    const car = await userDelegationCar();
    const result = await service().createInvocationFromDelegation(
      car,
      SERVICE_DID,
      { can: 'memory/*', with: 'ixo:memory' },
    );
    if ('error' in result) throw new Error(`mint failed: ${result.error}`);
    expect(result.invocation.length).toBeGreaterThan(100);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still resolves a URL target through /.well-known/did.json', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: SERVICE_DID }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    const car = await userDelegationCar();
    const result = await service().createInvocationFromDelegation(
      car,
      'https://memory.example.com/mcp',
      { can: 'memory/*', with: 'ixo:memory' },
    );
    expect(result).toHaveProperty('invocation');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://memory.example.com/.well-known/did.json',
      { signal: expect.any(AbortSignal) },
    );
  });
});

describe('WorkersUcanService.withCapabilities', () => {
  const service = () => new WorkersUcanService({ oracleDid: ORACLE_DID });

  it("reads a signed delegation's grants, which ctx.ucan.hasCapability then checks", async () => {
    const delegation = await service().withCapabilities(
      await userDelegationCar(),
    );
    expect(delegation.capabilities).toEqual([
      { resource: 'ixo:memory', action: 'memory/*' },
    ]);
    const ucan = createUcanAdapter(service(), () => undefined);
    expect(ucan.hasCapability(delegation, 'ixo:memory', 'memory/read')).toBe(
      true,
    );
    expect(
      ucan.hasCapability(delegation, 'ixo:memory/notes', 'memory/read'),
    ).toBe(true);
    // Not granted: another resource, another ability namespace, or a broader
    // resource than the one delegated.
    expect(ucan.hasCapability(delegation, 'ixo:filesystem', '*')).toBe(false);
    expect(ucan.hasCapability(delegation, 'ixo:memory', 'fs/read')).toBe(false);
    expect(ucan.hasCapability(delegation, 'ixo', 'memory/read')).toBe(false);
    // The core adapter a host without a signing key uses agrees.
    const unsigned = createNoopAmbient().ucan;
    expect(
      unsigned.hasCapability(delegation, 'ixo:memory', 'memory/read'),
    ).toBe(true);
    expect(unsigned.hasCapability(delegation, 'ixo', 'memory/read')).toBe(
      false,
    );
  });

  describe('a delegation that lapses while the object stays warm', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('grants while valid and nothing once expired, at every call and at every check', async () => {
      const expiration = Math.floor(Date.now() / 1000) + 1;
      const car = await userDelegationCar(expiration);
      const svc = service();
      const ucan = createUcanAdapter(svc, () => undefined);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(expiration * 1000 - 500);

      const live = await svc.withCapabilities(car);
      expect(live.expiration).toBe(expiration);
      expect(live.capabilities).toEqual([
        { resource: 'ixo:memory', action: 'memory/*' },
      ]);
      expect(ucan.hasCapability(live, 'ixo:memory', 'memory/read')).toBe(true);

      vi.setSystemTime(expiration * 1000 + 1);
      // The turn that started before the lapse stops granting at the lapse…
      expect(ucan.hasCapability(live, 'ixo:memory', 'memory/read')).toBe(false);
      // …and the next turn's delegation (same token, parse cached) grants nothing.
      const lapsed = await svc.withCapabilities(car);
      expect(lapsed.capabilities).toEqual([]);
      expect(ucan.hasCapability(lapsed, 'ixo:memory', 'memory/read')).toBe(
        false,
      );
    });

    it('load_capability refuses a plugin that requires what the lapsed delegation granted', async () => {
      const expiration = Math.floor(Date.now() / 1000) + 1;
      const car = await userDelegationCar(expiration);
      const svc = service();
      vi.useFakeTimers({ toFake: ['Date'] });
      const REQUIRES = [{ resource: 'ixo:memory', action: 'memory/read' }];
      const manifests = new ManifestRegistry();
      const tools = new ToolRegistry();
      const plugin = makePlugin({
        name: 'notes',
        manifest: makeManifest({
          title: 'Notes',
          visibility: 'on-demand',
          requires: REQUIRES,
        }),
        getTools: () => [makeTool('read_notes')],
      });
      manifests.register(plugin);
      tools.register(plugin);
      await tools.collect(makeBuildCtx());
      const load = buildLoadCapabilityTool(manifests, tools, {
        withheldToolNames: new Set(),
        hiddenPlugins: new Set(),
      });
      const turn = async () => {
        const run = makeRunConfig();
        return load.handler(
          { names: ['notes'] },
          makeRuntimeContext(
            { loadedPlugins: new Set<string>(), toolCallId: 'call-1' },
            {
              runConfig: {
                context: {
                  ...run.context,
                  user: {
                    ...run.context.user,
                    ucanDelegation: await svc.withCapabilities(car),
                  },
                },
              },
            },
          ),
        );
      };

      vi.setSystemTime(expiration * 1000 - 500);
      expect(await turn()).toBeInstanceOf(Command);

      vi.setSystemTime(expiration * 1000 + 1);
      const refused = await turn();
      expect(typeof refused).toBe('string');
      const [notes] = JSON.parse(String(refused)) as Array<{
        refused?: { missing: unknown };
      }>;
      expect(notes?.refused?.missing).toEqual(REQUIRES);
    });
  });

  it('grants nothing for a missing or unreadable token', async () => {
    expect(await service().withCapabilities('')).toEqual({ raw: '' });
    expect(await service().withCapabilities('not-a-delegation')).toEqual({
      raw: 'not-a-delegation',
      capabilities: [],
    });
  });
});

describe('resolveTurnDelegation', () => {
  const service = () => new WorkersUcanService({ oracleDid: ORACLE_DID });
  const rotateKey = adminToolCapability('keys', 'rotate_key');

  /** The user's own delegation to the oracle, granting `capabilities`. */
  async function userGrants(
    capabilities: Array<{
      can: `${string}/${string}`;
      with: `${string}:${string}`;
    }>,
  ): Promise<string> {
    const { signer } = await signerFromMnemonic(
      USER_MNEMONIC,
      USER_DID as `did:ixo:${string}`,
    );
    return serializeDelegation(
      await createDelegation({
        issuer: signer,
        audience: ORACLE_DID,
        capabilities,
        expiration: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
  }

  it('a header-less (Matrix) turn checks admin tools against the stored delegation', async () => {
    const svc = service();
    const ucan = createUcanAdapter(svc, () => undefined);
    const stored = await userGrants([
      { can: 'admin-tool/invoke', with: 'ixo:qiforge:admin-tool/keys' },
    ]);

    const matrixTurn = await resolveTurnDelegation(undefined, stored, svc);
    expect(matrixTurn.raw).toBe(stored);
    expect(
      ucan.hasCapability(matrixTurn, rotateKey.resource, rotateKey.action),
    ).toBe(true);

    // A request's own delegation wins over the stored one.
    const httpTurn = await resolveTurnDelegation(
      await userGrants([{ can: 'memory/*', with: 'ixo:memory' }]),
      stored,
      svc,
    );
    expect(
      ucan.hasCapability(httpTurn, rotateKey.resource, rotateKey.action),
    ).toBe(false);

    // Nothing stored, nothing sent, or no UCAN service: nothing granted.
    for (const nothing of [
      await resolveTurnDelegation(undefined, undefined, svc),
      await resolveTurnDelegation(undefined, stored, null),
    ]) {
      expect(
        ucan.hasCapability(nothing, rotateKey.resource, rotateKey.action),
      ).toBe(false);
    }
  });
});

describe('WorkersUcanService.getServiceDelegation', () => {
  const STORE = 'https://ucan-store.example.com';
  const fetchSpy = vi.fn<typeof fetch>();
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    fetchSpy.mockReset();
    globalThis.fetch = fetchSpy;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** The store's did.json, then its delegation listing with one row per grant. */
  function storeHolds(grants: Array<{ can: string; with: string }>): void {
    fetchSpy.mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/.well-known/did.json'))
        return Response.json({ id: 'did:web:ucan-store.example.com' });
      return Response.json({
        delegations: grants.map((grant, i) => ({
          token: `token-${i}`,
          capabilities: [grant],
          expiresAt: null,
          lifecycleState: 'active',
        })),
      });
    });
  }

  const ask = () =>
    new WorkersUcanService({
      oracleDid: ORACLE_DID,
      signingMnemonic: ORACLE_MNEMONIC,
    }).getServiceDelegation(USER_DID, {
      storeUrl: STORE,
      resource: 'ixo:filesystem',
      requiredAbility: 'fs/read',
    });

  it('never takes a sibling that only shares the prefix, or a narrower grant, for the resource asked for', async () => {
    storeHolds([
      { can: 'fs/*', with: 'ixo:filesystemX' },
      { can: 'fs/*', with: 'ixo:filesystem/did:ixo:entity:abc' },
    ]);
    expect(await ask()).toEqual({ error: 'no-delegation' });
  });

  it('takes the grant that covers the resource and the ability', async () => {
    storeHolds([
      { can: 'fs/*', with: 'ixo:filesystem/did:ixo:entity:abc' },
      { can: 'fs/write', with: 'ixo:filesystem' },
      { can: 'fs/*', with: 'ixo:filesystem' },
    ]);
    expect(await ask()).toEqual({ token: 'token-2', with: 'ixo:filesystem' });
    storeHolds([{ can: '*', with: '*' }]);
    expect(await ask()).toEqual({ token: 'token-0', with: '*' });
  });

  const listings = () =>
    fetchSpy.mock.calls.filter(
      ([input]) =>
        !String(input instanceof Request ? input.url : input).endsWith(
          '/.well-known/did.json',
        ),
    ).length;

  it('callers that miss the cache together share one store look-up', async () => {
    storeHolds([{ can: 'fs/*', with: 'ixo:filesystem' }]);
    const service = new WorkersUcanService({
      oracleDid: ORACLE_DID,
      signingMnemonic: ORACLE_MNEMONIC,
    });
    const opts = {
      storeUrl: STORE,
      resource: 'ixo:filesystem',
      requiredAbility: 'fs/read',
    };
    const results = await Promise.all([
      service.getServiceDelegation(USER_DID, opts),
      service.getServiceDelegation(USER_DID, opts),
      service.getServiceDelegation(USER_DID, opts),
    ]);
    for (const result of results)
      expect(result).toEqual({ token: 'token-0', with: 'ixo:filesystem' });
    expect(listings()).toBe(1);
    // A different ability is a different key: its own look-up.
    await service.getServiceDelegation(USER_DID, {
      ...opts,
      requiredAbility: 'fs/write',
    });
    expect(listings()).toBe(2);
  });

  it('a store that never answers gives every waiting caller store-error once the look-up times out', async () => {
    const service = new WorkersUcanService({
      oracleDid: ORACLE_DID,
      signingMnemonic: ORACLE_MNEMONIC,
      fetchTimeoutMs: 30,
    });
    // Answers nothing; gives up only when the request is aborted.
    fetchSpy.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason),
          );
        }),
    );
    const opts = {
      storeUrl: STORE,
      resource: 'ixo:filesystem',
      requiredAbility: 'fs/read',
    };
    const results = await Promise.all([
      service.getServiceDelegation(USER_DID, opts),
      service.getServiceDelegation(USER_DID, opts),
    ]);
    for (const result of results)
      expect(result).toMatchObject({ error: 'store-error' });
  }, 2_000);

  it('a failed look-up is not shared with the next call, which retries', async () => {
    const service = new WorkersUcanService({
      oracleDid: ORACLE_DID,
      signingMnemonic: ORACLE_MNEMONIC,
    });
    const opts = {
      storeUrl: STORE,
      resource: 'ixo:filesystem',
      requiredAbility: 'fs/read',
    };
    fetchSpy.mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/.well-known/did.json'))
        return Response.json({ id: 'did:web:ucan-store.example.com' });
      return new Response('down', { status: 503 });
    });
    const failed = await Promise.all([
      service.getServiceDelegation(USER_DID, opts),
      service.getServiceDelegation(USER_DID, opts),
    ]);
    expect(failed).toEqual([
      { error: 'store-error', detail: 'store 503' },
      { error: 'store-error', detail: 'store 503' },
    ]);
    expect(listings()).toBe(1);
    storeHolds([{ can: 'fs/*', with: 'ixo:filesystem' }]);
    expect(await service.getServiceDelegation(USER_DID, opts)).toEqual({
      token: 'token-0',
      with: 'ixo:filesystem',
    });
  });
});

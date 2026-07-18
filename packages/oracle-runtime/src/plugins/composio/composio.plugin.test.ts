import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { validateManifest } from '../../manifest/validator.js';
import { makeRuntimeContext } from '../../registries/test-fixtures.js';
import {
  COMPOSIO_DEFS_CACHE_MAX_ENTRIES,
  COMPOSIO_TOOL_DEFS_TTL_MS,
  createComposioTools,
  type ComposioDefsCache,
  type ComposioSessionFactory,
  type ComposioSessionTool,
} from './composio-tools.js';
import { ComposioPlugin } from './composio.plugin.js';

const COMPOSIO_URL = 'https://composio.test';
const COMPOSIO_API_KEY = 'ck-test-1234';

function fakeSessionTool(name: string): ComposioSessionTool {
  return {
    name,
    description: `composio tool ${name}`,
    schema: z.object({ value: z.string().optional() }),
    invoke: vi.fn(async (input: unknown) => ({ tool: name, echoed: input })),
  };
}

function buildConfig(overrides: Record<string, unknown> = {}) {
  return {
    COMPOSIO_API_KEY,
    COMPOSIO_BASE_URL: COMPOSIO_URL,
    NETWORK: 'testnet',
    ...overrides,
  };
}

describe('ComposioPlugin — identity & config', () => {
  it('exposes the expected plugin shape (name, version, manifest, autoDetect, configSchema)', () => {
    const plugin = new ComposioPlugin();
    expect(plugin.name).toBe('composio');
    expect(plugin.version).toBe('1.0.0');
    expect(plugin.manifest.visibility).toBe('on-demand');
    expect(plugin.manifest.category).toBe('integration');
    expect(plugin.autoDetectHint).toBe('COMPOSIO_API_KEY');
    expect(plugin.autoDetect({ COMPOSIO_API_KEY })).toBe(true);
    expect(plugin.autoDetect({})).toBe(false);

    const valid = plugin.configSchema.safeParse({ COMPOSIO_API_KEY });
    expect(valid.success).toBe(true);
    // COMPOSIO_BASE_URL has a default
    expect(valid.success && valid.data.COMPOSIO_BASE_URL).toBe(
      'https://composio.ixo.earth',
    );
    // Empty COMPOSIO_API_KEY rejected
    expect(
      plugin.configSchema.safeParse({ COMPOSIO_API_KEY: '' }).success,
    ).toBe(false);
    // Invalid URL rejected
    expect(
      plugin.configSchema.safeParse({
        COMPOSIO_API_KEY,
        COMPOSIO_BASE_URL: 'not-a-url',
      }).success,
    ).toBe(false);
  });

  it('manifest passes validateManifest', () => {
    const plugin = new ComposioPlugin();
    const result = validateManifest(plugin.manifest, plugin.name);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe('ComposioPlugin.getRequestTools — UCAN minting flow', () => {
  it('resolves the composio DID via runCtx.ucan, mints an ixo:sandbox invocation, and forwards it to the session factory', async () => {
    const resolveSpy = vi.fn(async (url: string) =>
      url === COMPOSIO_URL ? 'did:web:composio.test' : null,
    );
    const mintSpy = vi.fn(async () => 'ucan-token-1');
    const sessionFactory: ComposioSessionFactory = vi.fn(async () => [
      fakeSessionTool('COMPOSIO_SEARCH_TOOLS'),
      fakeSessionTool('GMAIL_SEND_EMAIL'),
    ]);

    const plugin = new ComposioPlugin({ sessionFactory });
    const rtCtx = makeRuntimeContext({
      config: buildConfig(),
      ucan: {
        hasCapability: () => true,
        requireCapability: () => undefined,
        mintInvocation: mintSpy,
        resolveServiceDid: resolveSpy,
        hasSigningKey: () => true,
        createInvocationFromDelegation: async () => ({
          invocation: 'mock-invocation-car',
        }),
        mintSelfSignedInvocation: async () => ({
          invocation: 'mock-invocation-car',
        }),
        getServiceDelegation: async () => ({ error: 'no-delegation' as const }),
      },
    });

    const tools = await plugin.getRequestTools(rtCtx);

    expect(resolveSpy).toHaveBeenCalledWith(COMPOSIO_URL);
    expect(mintSpy).toHaveBeenCalledWith(
      { did: 'did:web:composio.test', capability: 'ixo:sandbox' },
      { skipCache: true },
    );
    expect(sessionFactory).toHaveBeenCalledWith({
      apiKey: COMPOSIO_API_KEY,
      baseUrl: COMPOSIO_URL,
      ucanInvocation: 'ucan-token-1',
      userId: rtCtx.user.did,
      network: 'testnet',
    });
    expect(tools.map((t) => t.name)).toEqual([
      'COMPOSIO_SEARCH_TOOLS',
      'GMAIL_SEND_EMAIL',
    ]);
  });

  it('returns no tools when DID resolution fails (UCAN-only, no fallback)', async () => {
    const sessionFactory: ComposioSessionFactory = vi.fn();
    const plugin = new ComposioPlugin({ sessionFactory });
    const rtCtx = makeRuntimeContext({
      config: buildConfig(),
      ucan: {
        hasCapability: () => true,
        requireCapability: () => undefined,
        mintInvocation: vi.fn(),
        resolveServiceDid: async () => null,
        hasSigningKey: () => true,
        createInvocationFromDelegation: async () => ({
          invocation: 'mock-invocation-car',
        }),
        mintSelfSignedInvocation: async () => ({
          invocation: 'mock-invocation-car',
        }),
        getServiceDelegation: async () => ({ error: 'no-delegation' as const }),
      },
    });

    const tools = await plugin.getRequestTools(rtCtx);
    expect(tools).toEqual([]);
    expect(sessionFactory).not.toHaveBeenCalled();
  });

  it('returns no tools when COMPOSIO_API_KEY is absent from the merged config', async () => {
    const sessionFactory: ComposioSessionFactory = vi.fn();
    const mintInvocation = vi.fn();
    const plugin = new ComposioPlugin({ sessionFactory, mintInvocation });
    const rtCtx = makeRuntimeContext({
      config: { COMPOSIO_BASE_URL: COMPOSIO_URL },
    });

    const tools = await plugin.getRequestTools(rtCtx);
    expect(tools).toEqual([]);
    expect(mintInvocation).not.toHaveBeenCalled();
    expect(sessionFactory).not.toHaveBeenCalled();
  });
});

describe('ComposioPlugin.getRequestTools — wrapped tool semantics', () => {
  it('wraps each session tool into a PluginTool that forwards args via invoke()', async () => {
    const sessionTool = fakeSessionTool('LINEAR_CREATE_ISSUE');
    const sessionFactory: ComposioSessionFactory = async () => [sessionTool];
    const plugin = new ComposioPlugin({
      sessionFactory,
      mintInvocation: async () => 'ucan-token-2',
    });
    const rtCtx = makeRuntimeContext({ config: buildConfig() });

    const tools = await plugin.getRequestTools(rtCtx);
    expect(tools).toHaveLength(1);
    const tool = tools[0]!;
    expect(tool.name).toBe('LINEAR_CREATE_ISSUE');
    expect(tool.description).toBe('composio tool LINEAR_CREATE_ISSUE');
    expect(tool.schema).toBe(sessionTool.schema);

    const result = await tool.handler({ value: 'hi' }, rtCtx);
    expect(result).toEqual({
      tool: 'LINEAR_CREATE_ISSUE',
      echoed: { value: 'hi' },
    });
    expect(sessionTool.invoke).toHaveBeenCalledWith({ value: 'hi' });
  });

  it('defaults sync_response_to_workbench to false for COMPOSIO_MULTI_EXECUTE_TOOL when the model omits it', async () => {
    const sessionTool = fakeSessionTool('COMPOSIO_MULTI_EXECUTE_TOOL');
    const sessionFactory: ComposioSessionFactory = async () => [sessionTool];
    const plugin = new ComposioPlugin({
      sessionFactory,
      mintInvocation: async () => 'ucan-token-mx',
    });
    const rtCtx = makeRuntimeContext({ config: buildConfig() });

    const tools = await plugin.getRequestTools(rtCtx);
    const tool = tools[0]!;

    await tool.handler(
      { tools: [{ tool_slug: 'COMPOSIO_SEARCH_FINANCE', arguments: {} }] },
      rtCtx,
    );

    expect(sessionTool.invoke).toHaveBeenCalledWith({
      tools: [{ tool_slug: 'COMPOSIO_SEARCH_FINANCE', arguments: {} }],
      sync_response_to_workbench: false,
    });
  });

  it('preserves an explicit sync_response_to_workbench and never injects it for other tools', async () => {
    const multiExec = fakeSessionTool('COMPOSIO_MULTI_EXECUTE_TOOL');
    const other = fakeSessionTool('COMPOSIO_SEARCH_TOOLS');
    const sessionFactory: ComposioSessionFactory = async () => [
      multiExec,
      other,
    ];
    const plugin = new ComposioPlugin({
      sessionFactory,
      mintInvocation: async () => 'ucan-token-mx2',
    });
    const rtCtx = makeRuntimeContext({ config: buildConfig() });

    const [multiTool, otherTool] = await plugin.getRequestTools(rtCtx);

    // Explicit true is left untouched.
    await multiTool!.handler(
      { tools: [], sync_response_to_workbench: true },
      rtCtx,
    );
    expect(multiExec.invoke).toHaveBeenCalledWith({
      tools: [],
      sync_response_to_workbench: true,
    });

    // A different tool's args pass through verbatim — no injection.
    await otherTool!.handler({ query: 'find a tool' }, rtCtx);
    expect(other.invoke).toHaveBeenCalledWith({ query: 'find a tool' });
  });

  it('strips hallucinated envelope keys (e.g. session) from COMPOSIO_MULTI_EXECUTE_TOOL', async () => {
    const sessionTool = fakeSessionTool('COMPOSIO_MULTI_EXECUTE_TOOL');
    const sessionFactory: ComposioSessionFactory = async () => [sessionTool];
    const plugin = new ComposioPlugin({
      sessionFactory,
      mintInvocation: async () => 'ucan-token-mx3',
    });
    const rtCtx = makeRuntimeContext({ config: buildConfig() });
    const [tool] = await plugin.getRequestTools(rtCtx);

    // Exact shape from a real failure: a spurious `session` key alongside a
    // valid `tools` array. The envelope must be rebuilt to drop `session`.
    await tool!.handler(
      {
        session: { id: 'must' },
        tools: [
          {
            tool_slug: 'COMPOSIO_SEARCH_FINANCE',
            arguments: { query: 'GOOGL:NASDAQ', hl: 'en' },
          },
        ],
      },
      rtCtx,
    );

    expect(sessionTool.invoke).toHaveBeenCalledWith({
      tools: [
        {
          tool_slug: 'COMPOSIO_SEARCH_FINANCE',
          arguments: { query: 'GOOGL:NASDAQ', hl: 'en' },
        },
      ],
      sync_response_to_workbench: false,
    });
  });

  it('logs and returns no tools when the session factory throws (e.g. composio API outage)', async () => {
    const sessionFactory: ComposioSessionFactory = async () => {
      throw new Error('composio: 503 service unavailable');
    };
    const errorLogger = vi.fn();
    const plugin = new ComposioPlugin({
      sessionFactory,
      mintInvocation: async () => 'ucan-token-3',
    });
    const rtCtx = makeRuntimeContext({
      config: buildConfig(),
      logger: {
        log: () => undefined,
        warn: () => undefined,
        error: errorLogger,
      },
    });

    const tools = await plugin.getRequestTools(rtCtx);
    expect(tools).toEqual([]);
    expect(errorLogger).toHaveBeenCalledOnce();
    expect(String(errorLogger.mock.calls[0]?.[0])).toMatch(
      /503 service unavailable/,
    );
  });
});

describe('ComposioPlugin.getRequestTools — session tool-definition cache', () => {
  it('opens the session once, then serves later requests from the cache and connects lazily on invoke', async () => {
    const sessionTool = fakeSessionTool('COMPOSIO_SEARCH_TOOLS');
    const sessionFactory: ComposioSessionFactory = vi.fn(async () => [
      sessionTool,
    ]);
    const plugin = new ComposioPlugin({
      sessionFactory,
      mintInvocation: async () => 'ucan-token-cache',
    });
    const rtCtx = () => makeRuntimeContext({ config: buildConfig() });

    const cold = await plugin.getRequestTools(rtCtx());
    expect(cold.map((t) => t.name)).toEqual(['COMPOSIO_SEARCH_TOOLS']);
    expect(sessionFactory).toHaveBeenCalledTimes(1);

    const warm = await plugin.getRequestTools(rtCtx());
    // Same tool surface, no session opened while binding.
    expect(warm.map((t) => t.name)).toEqual(['COMPOSIO_SEARCH_TOOLS']);
    expect(warm[0]!.description).toBe(cold[0]!.description);
    expect(sessionFactory).toHaveBeenCalledTimes(1);

    // First invocation opens the session with THIS request's invocation.
    const result = await warm[0]!.handler(
      { value: 'find gmail tools' },
      makeRuntimeContext(),
    );
    expect(result).toEqual({
      tool: 'COMPOSIO_SEARCH_TOOLS',
      echoed: { value: 'find gmail tools' },
    });
    expect(sessionFactory).toHaveBeenCalledTimes(2);
    expect(sessionFactory).toHaveBeenLastCalledWith(
      expect.objectContaining({ ucanInvocation: 'ucan-token-cache' }),
    );
  });

  it('caches per user — a different DID still opens its own session', async () => {
    const sessionFactory: ComposioSessionFactory = vi.fn(async () => [
      fakeSessionTool('COMPOSIO_SEARCH_TOOLS'),
    ]);
    const plugin = new ComposioPlugin({
      sessionFactory,
      mintInvocation: async () => 'ucan-token-multi',
    });

    await plugin.getRequestTools(makeRuntimeContext({ config: buildConfig() }));
    await plugin.getRequestTools(
      makeRuntimeContext({
        config: buildConfig(),
        user: {
          did: 'did:ixo:user2',
          matrixUserId: '@did-ixo-user2:ixo.world',
          ucanDelegation: { raw: 'test-ucan-delegation' },
        },
      }),
    );

    expect(sessionFactory).toHaveBeenCalledTimes(2);
  });

  it('evicts expired entries on write, so one-off users do not accumulate for the process lifetime', async () => {
    const defsCache: ComposioDefsCache = new Map();
    defsCache.set(`${COMPOSIO_URL}::did:ixo:departed-user`, {
      defs: [{ name: 'STALE', description: 'stale', schema: undefined }],
      expiresAt: Date.now() - 1,
    });

    await createComposioTools({
      apiKey: COMPOSIO_API_KEY,
      baseUrl: COMPOSIO_URL,
      ucanInvocation: 'ucan-token-evict',
      userId: 'did:ixo:fresh-user',
      sessionFactory: async () => [fakeSessionTool('COMPOSIO_SEARCH_TOOLS')],
      defsCache,
    });

    expect(defsCache.has(`${COMPOSIO_URL}::did:ixo:departed-user`)).toBe(false);
    expect(defsCache.has(`${COMPOSIO_URL}::did:ixo:fresh-user`)).toBe(true);
  });

  it('caps the cache size, evicting the soonest-to-expire entries first', async () => {
    const defsCache: ComposioDefsCache = new Map();
    const base = Date.now() + COMPOSIO_TOOL_DEFS_TTL_MS;
    for (let i = 0; i < COMPOSIO_DEFS_CACHE_MAX_ENTRIES; i++) {
      defsCache.set(`${COMPOSIO_URL}::did:ixo:user-${i}`, {
        defs: [],
        expiresAt: base + i,
      });
    }

    await createComposioTools({
      apiKey: COMPOSIO_API_KEY,
      baseUrl: COMPOSIO_URL,
      ucanInvocation: 'ucan-token-cap',
      userId: 'did:ixo:one-more-user',
      sessionFactory: async () => [fakeSessionTool('COMPOSIO_SEARCH_TOOLS')],
      defsCache,
    });

    expect(defsCache.size).toBe(COMPOSIO_DEFS_CACHE_MAX_ENTRIES);
    // The soonest-to-expire seeded entry was evicted; the newest survives.
    expect(defsCache.has(`${COMPOSIO_URL}::did:ixo:user-0`)).toBe(false);
    expect(defsCache.has(`${COMPOSIO_URL}::did:ixo:one-more-user`)).toBe(true);
  });
});

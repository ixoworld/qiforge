import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createUnsignedUcanAdapter,
  type UcanAdapter,
} from '../../core/runtime-context';
import { makeRuntimeContext } from '../../core/test-fixtures';
import type { RuntimeContext } from '../../plugin-api/types';
import type { ComposioSessionTool } from './composio-tools';
import { ComposioPlugin } from './composio.plugin';

/** Captured `new Composio(...)` constructor options + session user ids. */
const composioCtorArgs: unknown[] = [];
const createdUserIds: string[] = [];
let sessionTools: ComposioSessionTool[] = [];

vi.mock('@composio/core', () => {
  class Composio {
    constructor(opts: unknown) {
      composioCtorArgs.push(opts);
    }
    async create(userId: string): Promise<{
      tools: () => Promise<ComposioSessionTool[]>;
    }> {
      createdUserIds.push(userId);
      return { tools: async () => sessionTools };
    }
  }
  return { Composio };
});

vi.mock('@composio/langchain', () => {
  class LangchainProvider {}
  return { LangchainProvider };
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

const BASE_URL = 'https://composio.example';

function makeCtx(overrides: Partial<UcanAdapter> = {}): RuntimeContext {
  const mintCalls: Array<{
    target: { did: string; capability: string };
    opts?: { skipCache?: boolean; can?: string };
  }> = [];
  const ucan: UcanAdapter = {
    ...createUnsignedUcanAdapter(),
    hasSigningKey: () => true,
    resolveServiceDid: async () => 'did:web:composio.example',
    mintInvocation: async (_userDid, target, opts) => {
      mintCalls.push({ target, opts });
      return 'composio-inv-token';
    },
    ...overrides,
  };
  const ctx = makeRuntimeContext(
    {},
    {
      ambient: {
        ucan,
        config: {
          COMPOSIO_API_KEY: 'ck-test',
          COMPOSIO_BASE_URL: BASE_URL,
          NETWORK: 'devnet',
        },
      },
    },
  );
  return Object.assign(ctx, { __mintCalls: mintCalls });
}

function mintCallsOf(ctx: RuntimeContext): Array<{
  target: { did: string; capability: string };
  opts?: { skipCache?: boolean; can?: string };
}> {
  const bag: unknown = ctx;
  if (isRecord(bag) && Array.isArray(bag.__mintCalls)) {
    return bag.__mintCalls;
  }
  return [];
}

describe('ComposioPlugin (Workers port)', () => {
  beforeEach(() => {
    composioCtorArgs.length = 0;
    createdUserIds.length = 0;
    sessionTools = [
      {
        name: 'COMPOSIO_SEARCH_TOOLS',
        description: 'discover tools',
        schema: z.object({ query: z.string() }),
        invoke: vi.fn(async (input: unknown) => ({ found: [], input })),
      },
      {
        name: 'COMPOSIO_MULTI_EXECUTE_TOOL',
        description: 'execute tools',
        schema: z.object({}),
        invoke: vi.fn(async (input: unknown) => ({ ran: input })),
      },
    ];
  });

  it('autoDetects on COMPOSIO_API_KEY', () => {
    const plugin = new ComposioPlugin();
    expect(plugin.autoDetect({})).toBe(false);
    expect(plugin.autoDetect({ COMPOSIO_API_KEY: 'k' })).toBe(true);
  });

  it('opens a per-user session with the x-ucan-invocation + x-ixo-network headers', async () => {
    const plugin = new ComposioPlugin();
    const ctx = makeCtx();
    const tools = await plugin.getRequestTools(ctx);

    expect(tools.map((t) => t.name).sort()).toEqual([
      'COMPOSIO_MULTI_EXECUTE_TOOL',
      'COMPOSIO_SEARCH_TOOLS',
    ]);

    // The invocation is minted per request with skipCache (replay protection).
    expect(mintCallsOf(ctx)).toEqual([
      {
        target: { did: 'did:web:composio.example', capability: 'ixo:sandbox' },
        opts: { skipCache: true, can: 'sandbox/*' },
      },
    ]);

    // The SDK client carried the auth header set + base URL + api key.
    expect(composioCtorArgs).toHaveLength(1);
    const ctorOpts = composioCtorArgs[0];
    if (!isRecord(ctorOpts)) throw new Error('missing ctor opts');
    expect(ctorOpts.apiKey).toBe('ck-test');
    expect(ctorOpts.baseURL).toBe(BASE_URL);
    expect(ctorOpts.defaultHeaders).toEqual({
      'x-ucan-invocation': 'composio-inv-token',
      'x-ixo-network': 'devnet',
    });
    expect(createdUserIds).toEqual(['did:ixo:user1']);
  });

  it('proxies a happy-path call to the session tool', async () => {
    const plugin = new ComposioPlugin();
    const ctx = makeCtx();
    const tools = await plugin.getRequestTools(ctx);
    const search = tools.find((t) => t.name === 'COMPOSIO_SEARCH_TOOLS');

    const result = await search?.handler({ query: 'finance' }, ctx);

    const upstream = sessionTools.find(
      (t) => t.name === 'COMPOSIO_SEARCH_TOOLS',
    );
    expect(upstream?.invoke).toHaveBeenCalledWith({ query: 'finance' });
    expect(result).toEqual({ found: [], input: { query: 'finance' } });
  });

  it('normalizes the COMPOSIO_MULTI_EXECUTE_TOOL envelope', async () => {
    const plugin = new ComposioPlugin();
    const ctx = makeCtx();
    const tools = await plugin.getRequestTools(ctx);
    const multi = tools.find((t) => t.name === 'COMPOSIO_MULTI_EXECUTE_TOOL');

    await multi?.handler(
      {
        tools: [{ tool_slug: 'COMPOSIO_SEARCH_FINANCE', arguments: {} }],
        session: 'hallucinated-junk',
      },
      ctx,
    );

    const upstream = sessionTools.find(
      (t) => t.name === 'COMPOSIO_MULTI_EXECUTE_TOOL',
    );
    expect(upstream?.invoke).toHaveBeenCalledWith({
      tools: [{ tool_slug: 'COMPOSIO_SEARCH_FINANCE', arguments: {} }],
      sync_response_to_workbench: false,
    });
  });

  it('contributes no tools when the invocation cannot be minted', async () => {
    const plugin = new ComposioPlugin();
    const tools = await plugin.getRequestTools(
      makeCtx({ resolveServiceDid: async () => null }),
    );
    expect(tools).toEqual([]);
    expect(composioCtorArgs).toHaveLength(0);
  });
});

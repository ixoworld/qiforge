import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { validateManifest } from '../../manifest/validator.js';
import {
  makeBuildCtx,
  makeRuntimeContext,
} from '../../registries/test-fixtures.js';
import { createTestRuntime } from '../../testing/create-test-runtime.js';
import {
  createDefaultSkillsUcanBuilder,
  type SkillsUcanBuilder,
} from './skills-ucan.js';
import { SkillsPlugin } from './skills.plugin.js';

const SKILLS_URL = 'https://capsules.skills.test';
const DEFAULT_URL = 'https://capsules.skills.ixo.earth';

/** Stub UCAN builder — returns a fixed invocation. */
const fixedUcan: SkillsUcanBuilder = async () => 'ucan-skills-token';

function getTool(plugin: SkillsPlugin, name: string) {
  const tools = plugin.getTools(
    makeBuildCtx({
      config: { SKILLS_CAPSULES_BASE_URL: SKILLS_URL, NETWORK: 'mainnet' },
    }),
  );
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found;
}

/**
 * Narrow the recorded fetch call to its concrete shape. The plugin always
 * passes `(stringUrl, init)`; we assert that and return a typed view of the
 * headers object the tool sent.
 */
function readFetchCall(call: Parameters<typeof globalThis.fetch>): {
  url: string;
  headers: Record<string, string>;
} {
  const [input, init] = call;
  if (typeof input !== 'string') {
    throw new Error('expected fetch() to be called with a string URL');
  }
  const rawHeaders = init?.headers;
  const headers: Record<string, string> = {};
  if (rawHeaders instanceof Headers) {
    rawHeaders.forEach((value, key) => {
      headers[key] = value;
    });
  } else if (Array.isArray(rawHeaders)) {
    for (const [k, v] of rawHeaders) headers[k] = v;
  } else if (rawHeaders && typeof rawHeaders === 'object') {
    for (const [k, v] of Object.entries(rawHeaders)) {
      if (typeof v === 'string') headers[k] = v;
    }
  }
  return { url: input, headers };
}

/**
 * Tool-handler result shape we assert against. Declared via Zod so the test
 * narrows the `unknown` handler return through a runtime parse rather than
 * a static type assertion.
 */
const listResultShape = z.object({
  skills: z.array(
    z.object({
      title: z.string(),
      source: z.enum(['private', 'public']),
      description: z.string(),
    }),
  ),
  privateSkillCount: z.number(),
});

describe('SkillsPlugin identity', () => {
  it('has the expected identity, manifest, configSchema, and depends on sandbox', () => {
    const plugin = new SkillsPlugin();
    expect(plugin.name).toBe('skills');
    expect(plugin.version).toBe('1.0.0');
    expect(plugin.dependsOn).toEqual(['sandbox']);
    expect(plugin.manifest.visibility).toBe('always');
    expect(plugin.manifest.stability).toBe('stable');
    expect(plugin.manifest.category).toBe('data');

    // configSchema defaults SKILLS_CAPSULES_BASE_URL when absent
    const defaulted = plugin.configSchema.safeParse({});
    // Throw-then-assert so the discriminated union is refined for the data
    // access on the next line — keeps the assertion unconditional (the lint
    // rule flags a wrapping `if (defaulted.success)`).
    if (!defaulted.success) {
      throw new Error(
        `expected configSchema to accept {}, got: ${defaulted.error.message}`,
      );
    }
    expect(defaulted.data.SKILLS_CAPSULES_BASE_URL).toBe(DEFAULT_URL);
    // Rejects non-URL values
    expect(
      plugin.configSchema.safeParse({ SKILLS_CAPSULES_BASE_URL: 'nope' })
        .success,
    ).toBe(false);

    // Manifest passes the runtime's validator
    expect(validateManifest(plugin.manifest, plugin.name).valid).toBe(true);
  });

  it('exposes exactly list_skills and search_skills via getTools', () => {
    const plugin = new SkillsPlugin({ ucanBuilder: fixedUcan });
    const tools = plugin.getTools(
      makeBuildCtx({ config: { SKILLS_CAPSULES_BASE_URL: SKILLS_URL } }),
    );
    expect(tools.map((t) => t.name).sort()).toEqual([
      'list_skills',
      'search_skills',
    ]);
  });
});

describe('createDefaultSkillsUcanBuilder', () => {
  it('mints an ixo:skills invocation via runCtx.ucan and returns undefined on resolveServiceDid null', async () => {
    const resolveSpy = vi.fn(async (url: string) =>
      url === SKILLS_URL ? 'did:web:skills.test' : null,
    );
    const mintSpy = vi.fn(async () => 'minted-token');
    const runCtx = makeRuntimeContext({
      ucan: {
        hasCapability: () => true,
        requireCapability: () => undefined,
        mintInvocation: mintSpy,
        resolveServiceDid: resolveSpy,
        hasSigningKey: () => true,
        createInvocationFromDelegation: async () => ({
          invocation: 'mock-invocation-car',
        }),
      },
    });

    const builder = createDefaultSkillsUcanBuilder();
    const token = await builder(SKILLS_URL, runCtx);

    expect(resolveSpy).toHaveBeenCalledWith(SKILLS_URL);
    expect(mintSpy).toHaveBeenCalledWith({
      did: 'did:web:skills.test',
      capability: 'ixo:skills',
    });
    expect(token).toBe('minted-token');

    // When DID resolution returns null the builder returns undefined and
    // mintInvocation is never called.
    const runCtxNoDid = makeRuntimeContext({
      ucan: {
        hasCapability: () => true,
        requireCapability: () => undefined,
        mintInvocation: vi.fn(),
        resolveServiceDid: async () => null,
        hasSigningKey: () => true,
        createInvocationFromDelegation: async () => ({
          invocation: 'mock-invocation-car',
        }),
      },
    });
    expect(await builder(SKILLS_URL, runCtxNoDid)).toBeUndefined();
  });
});

describe('skills tools (HTTP behavior)', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  afterEach(() => {
    fetchSpy.mockReset();
  });

  it('list_skills forwards the UCAN as Authorization, ranks private first, and pages via limit/offset', async () => {
    const body = {
      capsules: [
        {
          cid: 'cidA',
          name: 'public-a',
          description: 'pub',
          visibility: 'public' as const,
        },
        {
          cid: 'cidB',
          name: 'private-b',
          description: 'priv',
          visibility: 'private' as const,
        },
      ],
      pagination: { total: 2, limit: 5, offset: 0, hasMore: false },
    };
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(body), { status: 200 }),
    );

    const plugin = new SkillsPlugin({ ucanBuilder: fixedUcan });
    const list = getTool(plugin, 'list_skills');
    const raw = await list.handler(
      { limit: 5, offset: 0 },
      makeRuntimeContext(),
    );
    const result = listResultShape.parse(raw);

    // Private skill ranked before public.
    expect(result.skills.map((s) => s.title)).toEqual([
      'private-b',
      'public-a',
    ]);
    expect(result.privateSkillCount).toBe(1);

    // fetch URL + auth headers
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const recorded = readFetchCall(fetchSpy.mock.calls[0]!);
    const u = new URL(recorded.url);
    expect(u.origin + u.pathname).toBe(`${SKILLS_URL}/capsules`);
    expect(u.searchParams.get('limit')).toBe('5');
    expect(u.searchParams.get('offset')).toBe('0');

    expect(recorded.headers.Authorization).toBe('Bearer ucan-skills-token');
    expect(recorded.headers['X-Auth-Type']).toBe('ucan');
    expect(recorded.headers['X-IXO-Network']).toBe('mainnet');
  });

  it('search_skills degrades to public-only headers when UCAN minting yields undefined, and dedups by name', async () => {
    const body = {
      query: 'pptx',
      count: 3,
      capsules: [
        {
          cid: 'c1',
          name: 'pptx-builder',
          description: 'public ver',
          visibility: 'public' as const,
        },
        {
          cid: 'c2',
          name: 'pptx-builder',
          description: 'private ver',
          visibility: 'private' as const,
        },
        {
          cid: 'c3',
          name: 'invoice',
          description: 'other',
          visibility: 'public' as const,
        },
      ],
    };
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(body), { status: 200 }),
    );

    const noUcan: SkillsUcanBuilder = async () => undefined;
    const plugin = new SkillsPlugin({ ucanBuilder: noUcan });
    const search = getTool(plugin, 'search_skills');
    const raw = await search.handler({ q: 'pptx' }, makeRuntimeContext());
    const result = listResultShape.parse(raw);

    // Dedup keeps the private row over the public one with the same name.
    const pptx = result.skills.find((s) => s.title === 'pptx-builder');
    expect(pptx?.source).toBe('private');
    expect(pptx?.description).toBe('private ver');
    expect(result.privateSkillCount).toBe(1);

    // No Authorization header — public-only mode.
    const recorded = readFetchCall(fetchSpy.mock.calls[0]!);
    expect(recorded.headers.Authorization).toBeUndefined();
    expect(recorded.headers['X-Auth-Type']).toBeUndefined();
    expect(recorded.headers['X-IXO-Network']).toBe('mainnet');
  });

  it('throws a descriptive error when the registry returns a non-2xx response', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('boom', { status: 503, statusText: 'Service Unavailable' }),
    );
    const plugin = new SkillsPlugin({ ucanBuilder: fixedUcan });
    const list = getTool(plugin, 'list_skills');
    await expect(list.handler({}, makeRuntimeContext())).rejects.toThrow(
      /List skills failed/,
    );

    // Empty search queries are rejected by the Zod schema.
    const search = getTool(plugin, 'search_skills');
    await expect(
      search.handler({ q: '' }, makeRuntimeContext()),
    ).rejects.toThrow();
  });
});

describe('SkillsPlugin loads via createTestRuntime', () => {
  it('registers list_skills and search_skills when SKILLS_CAPSULES_BASE_URL is provided alongside the sandbox plugin', async () => {
    // Skills hard-depends on sandbox, so the runtime needs both to satisfy
    // the topo-sort. We import sandbox lazily to keep test imports minimal.
    const { SandboxPlugin } = await import('../sandbox/index.js');
    const rt = await createTestRuntime({
      plugins: [
        new SandboxPlugin(),
        new SkillsPlugin({ ucanBuilder: fixedUcan }),
      ],
      config: {
        SANDBOX_MCP_URL: 'https://sandbox.test',
        SKILLS_CAPSULES_BASE_URL: SKILLS_URL,
        NETWORK: 'mainnet',
      },
    });
    rt.assertNoCollisions();
    rt.assertManifestValid();
    expect(
      rt
        .listTools('skills')
        .map((t) => t.name)
        .sort(),
    ).toEqual(['list_skills', 'search_skills']);
    await rt.close();
  });
});

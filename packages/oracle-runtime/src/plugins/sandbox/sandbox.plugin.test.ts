import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { validateManifest } from '../../manifest/validator.js';
import type { RuntimeContext } from '../../plugin-api/types.js';
import { makeRuntimeContext } from '../../registries/test-fixtures.js';
import {
  createDefaultAuthBuilder,
  parseOracleSecrets,
  type SandboxAuthBuilder,
} from './sandbox-mcp.js';
import {
  SandboxPlugin,
  type SandboxMcpClientFactory,
  type SandboxMcpTool,
} from './sandbox.plugin.js';

const SANDBOX_URL = 'https://sandbox.test';
const SKILLS_URL = 'https://capsules.skills.test';

/** Recorded MCP-client config the test factory captures on each construction. */
interface RecordedMcpConfig {
  url: string;
  headers: Record<string, string>;
}

/** Narrow an arbitrary value to `Record<string, string>` (test guard). */
function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') {
    throw new Error('expected an object');
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') {
      throw new Error(`expected string header value for ${k}, got ${typeof v}`);
    }
    out[k] = v;
  }
  return out;
}

/**
 * Build a stub MCP client factory that returns the supplied upstream tools.
 * Records every client config it sees so tests can assert on the headers
 * passed to the MCP server.
 */
function makeMcpFactory(upstream: SandboxMcpTool[]) {
  const closeSpy = vi.fn(async () => undefined);
  const seenConfigs: RecordedMcpConfig[] = [];
  const factory: SandboxMcpClientFactory = (config) => {
    const server = config.mcpServers.sandbox;
    if (!server || typeof server !== 'object') {
      throw new Error('test factory: unexpected mcpServers shape');
    }
    if (!('url' in server) || typeof server.url !== 'string') {
      throw new Error('test factory: missing url');
    }
    if (!('headers' in server)) {
      throw new Error('test factory: missing headers');
    }
    seenConfigs.push({
      url: server.url,
      headers: asStringRecord(server.headers),
    });
    return {
      getTools: async () => upstream,
      close: closeSpy,
    };
  };
  return { factory, closeSpy, seenConfigs };
}

/** Build an upstream MCP tool double with a recorded invoke spy. */
function makeUpstreamTool(
  name: string,
  invokeImpl: (input: unknown) => Promise<unknown> = async () => `${name}-ok`,
): SandboxMcpTool & { invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(invokeImpl);
  return {
    name,
    description: `Upstream description for ${name}`,
    schema: z.object({ command: z.string() }),
    invoke,
  };
}

/** Sandbox-specific RuntimeContext defaults shared across the suite. */
function makeSandboxRuntimeContext(
  overrides: Partial<RuntimeContext> = {},
): RuntimeContext {
  return makeRuntimeContext({
    config: { SANDBOX_MCP_URL: SANDBOX_URL },
    ...overrides,
  });
}

describe('parseOracleSecrets', () => {
  it('parses comma-separated KEY=VALUE pairs, trimming whitespace', () => {
    expect(parseOracleSecrets('OPENAI=sk-1, STRIPE=stripe_2 ')).toEqual({
      OPENAI: 'sk-1',
      STRIPE: 'stripe_2',
    });
  });

  it('skips malformed entries silently (empty / no equals / blank key)', () => {
    expect(parseOracleSecrets('=foo,bar,BAZ=qux,,= ')).toEqual({ BAZ: 'qux' });
  });

  it('returns an empty object when input is empty', () => {
    expect(parseOracleSecrets('')).toEqual({});
  });
});

describe('createDefaultAuthBuilder', () => {
  it('resolves sandbox + skills DIDs via runCtx.ucan.resolveServiceDid and mints both invocations', async () => {
    const resolveSpy = vi.fn(async (url: string) => {
      if (url === SANDBOX_URL) return 'did:web:sandbox.test';
      if (url === SKILLS_URL) return 'did:web:skills.test';
      return null;
    });
    const mintSpy = vi.fn(async ({ capability }: { capability: string }) =>
      capability === 'ixo:sandbox' ? 'inv-sandbox' : 'inv-skills',
    );
    const runCtx = makeRuntimeContext({
      ucan: {
        hasCapability: () => true,
        requireCapability: () => undefined,
        mintInvocation: mintSpy,
        resolveServiceDid: resolveSpy,
      },
    });

    const headers = await createDefaultAuthBuilder()(
      {
        sandboxMcpUrl: SANDBOX_URL,
        skillsServiceUrl: SKILLS_URL,
        oracleSecrets: { OPENAI_KEY: 'sk-1' },
        userSecrets: { DB: 'pg://x' },
      },
      runCtx,
    );

    expect(resolveSpy).toHaveBeenCalledWith(SANDBOX_URL);
    expect(resolveSpy).toHaveBeenCalledWith(SKILLS_URL);
    expect(headers.Authorization).toBe('Bearer inv-sandbox');
    expect(headers['X-Auth-Type']).toBe('ucan');
    expect(headers['X-Skills-Invocation']).toBe('inv-skills');
    expect(headers['x-os-openai_key']).toBe('sk-1');
    expect(headers['x-us-db']).toBe('pg://x');
  });

  it('omits the Authorization header when sandbox DID resolution returns null', async () => {
    const runCtx = makeRuntimeContext({
      ucan: {
        hasCapability: () => true,
        requireCapability: () => undefined,
        mintInvocation: vi.fn(),
        resolveServiceDid: async () => null,
      },
    });

    const headers = await createDefaultAuthBuilder()(
      {
        sandboxMcpUrl: SANDBOX_URL,
        oracleSecrets: {},
        userSecrets: {},
      },
      runCtx,
    );

    expect(headers.Authorization).toBeUndefined();
    expect(headers['X-Auth-Type']).toBeUndefined();
  });
});

describe('SandboxPlugin', () => {
  it('has the expected identity, manifest, and configSchema', () => {
    const plugin = new SandboxPlugin();
    expect(plugin.name).toBe('sandbox');
    expect(plugin.version).toBe('1.0.0');
    expect(plugin.manifest.visibility).toBe('always');
    expect(plugin.manifest.stability).toBe('stable');
    expect(plugin.autoDetectHint).toBe('SANDBOX_MCP_URL');
    expect(plugin.autoDetect!({ SANDBOX_MCP_URL: SANDBOX_URL })).toBe(true);
    expect(plugin.autoDetect!({})).toBe(false);

    const ok = plugin.configSchema!.safeParse({ SANDBOX_MCP_URL: SANDBOX_URL });
    expect(ok.success).toBe(true);
    expect(plugin.configSchema!.safeParse({}).success).toBe(false);
    expect(
      plugin.configSchema!.safeParse({ SANDBOX_MCP_URL: 'not-a-url' }).success,
    ).toBe(false);
  });

  it('manifest passes validateManifest', () => {
    const plugin = new SandboxPlugin();
    const result = validateManifest(plugin.manifest, plugin.name);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  describe('getRequestTools', () => {
    let authBuilder: SandboxAuthBuilder;

    beforeEach(() => {
      // Stub UCAN minting — returns sandbox auth headers plus a skills
      // invocation when SKILLS_CAPSULES_BASE_URL is configured, and folds
      // operator / user secrets into x-os-* / x-us-* headers.
      authBuilder = vi.fn(async (inputs) => {
        const headers: Record<string, string> = {
          Authorization: 'Bearer ucan-sandbox',
          'X-Auth-Type': 'ucan',
        };
        if (inputs.skillsServiceUrl) {
          headers['X-Skills-Invocation'] = 'ucan-skills';
        }
        for (const [k, v] of Object.entries(inputs.oracleSecrets)) {
          headers[`x-os-${k.toLowerCase()}`] = v;
        }
        for (const [k, v] of Object.entries(inputs.userSecrets)) {
          headers[`x-us-${k.toLowerCase()}`] = v;
        }
        return headers;
      });
    });

    it('rejects boot when SANDBOX_MCP_URL is missing', async () => {
      const { factory } = makeMcpFactory([]);
      const plugin = new SandboxPlugin({
        authBuilder,
        mcpClientFactory: factory,
      });
      await expect(
        plugin.getRequestTools(makeRuntimeContext({ config: {} })),
      ).rejects.toThrow(/SANDBOX_MCP_URL/);
    });

    it('surfaces every upstream MCP tool verbatim (name, description, schema, handler delegates to upstream invoke)', async () => {
      const upstream = [
        makeUpstreamTool('sandbox_run', async (a) => ({ ran: a })),
        makeUpstreamTool('sandbox_write_file', async (a) => ({ wrote: a })),
        makeUpstreamTool('artifact_list'),
      ];
      const { factory, seenConfigs } = makeMcpFactory(upstream);

      const plugin = new SandboxPlugin({
        authBuilder,
        mcpClientFactory: factory,
      });

      const tools = await plugin.getRequestTools(makeSandboxRuntimeContext());

      expect(tools.map((t) => t.name)).toEqual([
        'sandbox_run',
        'sandbox_write_file',
        'artifact_list',
      ]);
      expect(tools[1]!.description).toBe(
        'Upstream description for sandbox_write_file',
      );
      expect(tools[1]!.schema).toBe(upstream[1]!.schema);

      // Handler forwards args verbatim to the upstream invoke
      const result = await tools[0]!.handler(
        { command: 'echo hi' },
        makeRuntimeContext(),
      );
      expect(result).toEqual({ ran: { command: 'echo hi' } });
      expect(upstream[0]!.invoke).toHaveBeenCalledWith({ command: 'echo hi' });

      // One MCP client built per request — no second client for sandbox_run
      expect(seenConfigs).toHaveLength(1);
    });

    it('mints headers once per request and includes auth, skills, oracle (x-os-*) and user (x-us-*) secrets', async () => {
      const upstream = [makeUpstreamTool('sandbox_run')];
      const { factory, seenConfigs } = makeMcpFactory(upstream);

      const plugin = new SandboxPlugin({
        authBuilder,
        mcpClientFactory: factory,
      });

      const rtCtx = makeSandboxRuntimeContext({
        config: {
          SANDBOX_MCP_URL: SANDBOX_URL,
          SKILLS_CAPSULES_BASE_URL: SKILLS_URL,
          ORACLE_SECRETS: 'OPENAI_KEY=sk-oracle,STRIPE_KEY=stripe-oracle',
        },
        secrets: {
          getIndex: async () => ({ DATABASE_URL: { key: 'DATABASE_URL' } }),
          getValues: async (keys: string[]) => {
            const out: Record<string, string> = {};
            for (const k of keys) {
              if (k === 'DATABASE_URL')
                out[k] = 'postgres://user:pass@host/db';
            }
            return out;
          },
        },
      });

      await plugin.getRequestTools(rtCtx);

      expect(seenConfigs).toHaveLength(1);
      const headers = seenConfigs[0]!.headers;
      expect(headers.Authorization).toBe('Bearer ucan-sandbox');
      expect(headers['X-Auth-Type']).toBe('ucan');
      expect(headers['X-Skills-Invocation']).toBe('ucan-skills');
      expect(headers['x-os-openai_key']).toBe('sk-oracle');
      expect(headers['x-os-stripe_key']).toBe('stripe-oracle');
      expect(headers['x-us-database_url']).toBe(
        'postgres://user:pass@host/db',
      );

      expect(authBuilder).toHaveBeenCalledTimes(1);
      expect(authBuilder).toHaveBeenCalledWith(
        {
          sandboxMcpUrl: SANDBOX_URL,
          skillsServiceUrl: SKILLS_URL,
          oracleSecrets: { OPENAI_KEY: 'sk-oracle', STRIPE_KEY: 'stripe-oracle' },
          userSecrets: { DATABASE_URL: 'postgres://user:pass@host/db' },
        },
        rtCtx,
      );
    });

    it('filters out oracle_* management tools by default', async () => {
      const upstream = [
        makeUpstreamTool('sandbox_run'),
        makeUpstreamTool('sandbox_write_file'),
        makeUpstreamTool('oracle_list'),
        makeUpstreamTool('oracle_stop'),
        makeUpstreamTool('oracle_get_logs'),
        makeUpstreamTool('artifact_list'),
      ];
      const { factory } = makeMcpFactory(upstream);

      const plugin = new SandboxPlugin({
        authBuilder,
        mcpClientFactory: factory,
      });

      const tools = await plugin.getRequestTools(makeSandboxRuntimeContext());
      expect(tools.map((t) => t.name)).toEqual([
        'sandbox_run',
        'sandbox_write_file',
        'artifact_list',
      ]);
    });

    it('includes oracle_* management tools when includeOracleManagementTools is enabled', async () => {
      const upstream = [
        makeUpstreamTool('sandbox_run'),
        makeUpstreamTool('oracle_list'),
        makeUpstreamTool('oracle_stop'),
        makeUpstreamTool('artifact_list'),
      ];
      const { factory } = makeMcpFactory(upstream);

      const plugin = new SandboxPlugin({
        authBuilder,
        mcpClientFactory: factory,
        includeOracleManagementTools: true,
      });

      const tools = await plugin.getRequestTools(makeSandboxRuntimeContext());
      expect(tools.map((t) => t.name)).toEqual([
        'sandbox_run',
        'oracle_list',
        'oracle_stop',
        'artifact_list',
      ]);
    });

    it('skips user-secret loading when the room has no indexed secrets', async () => {
      const upstream = [makeUpstreamTool('sandbox_run')];
      const { factory } = makeMcpFactory(upstream);
      const getValuesSpy = vi.fn(async () => ({}));

      const plugin = new SandboxPlugin({
        authBuilder,
        mcpClientFactory: factory,
      });

      await plugin.getRequestTools(
        makeSandboxRuntimeContext({
          secrets: {
            getIndex: async () => ({}),
            getValues: getValuesSpy,
          },
        }),
      );

      expect(getValuesSpy).not.toHaveBeenCalled();
    });
  });
});

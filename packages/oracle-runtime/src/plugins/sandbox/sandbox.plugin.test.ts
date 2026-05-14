import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateManifest } from '../../manifest/validator.js';
import type {
  PluginContext,
  RuntimeContext,
} from '../../plugin-api/types.js';
import {
  makeBuildCtx,
  makeRuntimeContext,
} from '../../registries/test-fixtures.js';
import { createTestRuntime } from '../../testing/create-test-runtime.js';
import {
  createDefaultAuthBuilder,
  parseOracleSecrets,
  type SandboxAuthBuilder,
} from './sandbox-mcp.js';
import { SandboxPlugin } from './sandbox.plugin.js';

const SANDBOX_URL = 'https://sandbox.test';
const SKILLS_URL = 'https://capsules.skills.test';

/** Build a `PluginContext` with the env vars sandbox cares about. */
function buildCtx(overrides: Record<string, unknown> = {}): PluginContext {
  return makeBuildCtx({
    config: {
      SANDBOX_MCP_URL: SANDBOX_URL,
      ORACLE_SECRETS: '',
      ...overrides,
    },
  });
}

/** Recorded MCP client config (shape we assert against in tests). */
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

/** A noop MCP client factory backed by a recorded handler. */
function makeMcpFactory(
  invokeImpl: (args: unknown) => Promise<unknown> = async () => 'ok',
  toolName = 'sandbox_run',
) {
  const closeSpy = vi.fn(async () => undefined);
  const invokeSpy = vi.fn(invokeImpl);
  const seenConfigs: RecordedMcpConfig[] = [];
  const factory = (config: { mcpServers: Record<string, unknown> }) => {
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
      getTools: async () => [{ name: toolName, invoke: invokeSpy }],
      close: closeSpy,
    };
  };
  return { factory, closeSpy, invokeSpy, seenConfigs };
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
    // Required env enforced
    expect(plugin.configSchema!.safeParse({}).success).toBe(false);
    // URL validity enforced
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

  describe('getTools(sandbox_run)', () => {
    let authBuilder: SandboxAuthBuilder;

    beforeEach(() => {
      // Stub UCAN minting — returns sandbox auth + a skills invocation
      // when SKILLS_CAPSULES_BASE_URL is configured.
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

    it('throws when SANDBOX_MCP_URL is missing', () => {
      const plugin = new SandboxPlugin({ authBuilder });
      expect(() => plugin.getTools(makeBuildCtx({ config: {} }))).toThrow(
        /SANDBOX_MCP_URL/,
      );
    });

    it('exposes exactly one sandbox_run tool', () => {
      const plugin = new SandboxPlugin({ authBuilder });
      const tools = plugin.getTools(buildCtx());
      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe('sandbox_run');
    });

    it('mints headers, injects oracle + user secrets as x-os-*/x-us-*, and forwards args to the MCP sandbox_run tool', async () => {
      // Drive `createSandboxRunTool` directly so the test can intercept the
      // MCP client factory. The plugin-level wiring is covered by the
      // separate "loads via createTestRuntime" test below.
      const { factory, invokeSpy, seenConfigs, closeSpy } = makeMcpFactory(
        async (a) => ({ echoed: a }),
      );
      const { createSandboxRunTool } = await import('./sandbox-run-tool.js');
      const wrapped = createSandboxRunTool({
        sandboxMcpUrl: SANDBOX_URL,
        skillsServiceUrl: SKILLS_URL,
        oracleSecretsRaw: 'OPENAI_KEY=sk-oracle,STRIPE_KEY=stripe-oracle',
        authBuilder,
        mcpClientFactory: factory,
      });

      const runCtx = makeRuntimeContext({
        secrets: {
          getIndex: async () => ({ DATABASE_URL: { key: 'DATABASE_URL' } }),
          getValues: async (keys: string[]) => {
            const out: Record<string, string> = {};
            for (const k of keys) {
              if (k === 'DATABASE_URL') out[k] = 'postgres://user:pass@host/db';
            }
            return out;
          },
        },
      }) satisfies RuntimeContext;

      const result = await wrapped.handler({ command: 'python -c print(1)' }, runCtx);
      expect(result).toEqual({ echoed: { command: 'python -c print(1)' } });

      // MCP client was constructed once with our headers
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

      // authBuilder received the correct inputs (URL + parsed secrets)
      expect(authBuilder).toHaveBeenCalledWith(
        {
          sandboxMcpUrl: SANDBOX_URL,
          skillsServiceUrl: SKILLS_URL,
          oracleSecrets: { OPENAI_KEY: 'sk-oracle', STRIPE_KEY: 'stripe-oracle' },
          userSecrets: { DATABASE_URL: 'postgres://user:pass@host/db' },
        },
        runCtx,
      );

      // Forwarded args to the underlying MCP tool
      expect(invokeSpy).toHaveBeenCalledWith({ command: 'python -c print(1)' });

      // Client released after the call
      expect(closeSpy).toHaveBeenCalled();
    });

    it('throws a descriptive error when the MCP server omits a sandbox_run tool', async () => {
      const { createSandboxRunTool } = await import('./sandbox-run-tool.js');
      const { factory } = makeMcpFactory(undefined, 'something_else');
      const wrapped = createSandboxRunTool({
        sandboxMcpUrl: SANDBOX_URL,
        oracleSecretsRaw: '',
        authBuilder,
        mcpClientFactory: factory,
      });
      await expect(
        wrapped.handler({}, makeRuntimeContext()),
      ).rejects.toThrow(/sandbox_run.*Available tools: something_else/);
    });
  });

  it('loads via createTestRuntime and registers sandbox_run', async () => {
    const rt = await createTestRuntime({
      plugins: [new SandboxPlugin()],
      config: { SANDBOX_MCP_URL: SANDBOX_URL, ORACLE_SECRETS: '' },
    });
    rt.assertNoCollisions();
    rt.assertManifestValid();
    expect(rt.listTools('sandbox').map((t) => t.name)).toEqual(['sandbox_run']);
    await rt.close();
  });
});

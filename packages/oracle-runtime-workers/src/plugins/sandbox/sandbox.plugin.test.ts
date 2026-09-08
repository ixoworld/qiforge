import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createUnsignedUcanAdapter,
  type UcanAdapter,
} from '../../core/runtime-context';
import { makeRuntimeContext } from '../../core/test-fixtures';
import type { RuntimeContext } from '../../plugin-api/types';
import {
  SandboxPlugin,
  type SandboxMcpClientFactory,
  type SandboxMcpTool,
} from './sandbox.plugin';

const SANDBOX_URL = 'https://sandbox.example/mcp';
const SKILLS_URL = 'https://capsules.skills.example';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Pull the headers the plugin handed the MCP client factory. */
function headersOf(config: unknown): Record<string, unknown> {
  if (!isRecord(config) || !isRecord(config.mcpServers)) {
    throw new Error('factory received a malformed config');
  }
  const server = config.mcpServers.sandbox;
  if (!isRecord(server) || !isRecord(server.headers)) {
    throw new Error('no sandbox server headers');
  }
  return server.headers;
}

describe('SandboxPlugin (Workers port)', () => {
  let capturedConfigs: unknown[];
  let runInvocations: unknown[];
  let writeInvocations: unknown[];
  let upstream: SandboxMcpTool[];
  let factory: SandboxMcpClientFactory;

  beforeEach(() => {
    capturedConfigs = [];
    runInvocations = [];
    writeInvocations = [];
    upstream = [
      {
        name: 'sandbox_run',
        description: 'run code',
        schema: z.object({ code: z.string() }),
        invoke: async (input: unknown) => {
          runInvocations.push(input);
          return JSON.stringify({ success: true, exitCode: 0, output: 'hi' });
        },
      },
      {
        name: 'sandbox_write_file',
        description: 'write file',
        schema: z.object({ path: z.string(), content: z.string() }),
        invoke: async (input: unknown) => {
          writeInvocations.push(input);
          return JSON.stringify({ success: true });
        },
      },
      {
        name: 'oracle_list',
        description: 'operator-only',
        schema: z.object({}),
        invoke: async () => 'nope',
      },
    ];
    factory = (config) => {
      capturedConfigs.push(config);
      return {
        getTools: async () => upstream,
        close: async () => undefined,
      };
    };
  });

  function makeCtx(overrides: Partial<UcanAdapter> = {}): RuntimeContext {
    const ucan: UcanAdapter = {
      ...createUnsignedUcanAdapter(),
      hasSigningKey: () => true,
      resolveServiceDid: async (url: string) =>
        url === SKILLS_URL
          ? 'did:web:skills.example'
          : 'did:web:sandbox.example',
      mintInvocation: async (_userDid, target) =>
        target.capability === 'ixo:skills' ? 'skills-token' : 'sandbox-token',
      ...overrides,
    };
    return makeRuntimeContext(
      {},
      {
        ambient: {
          ucan,
          config: {
            SANDBOX_MCP_URL: SANDBOX_URL,
            ORACLE_SECRETS: 'API_KEY=os-value, Other_Key=second',
            SKILLS_CAPSULES_BASE_URL: SKILLS_URL,
          },
          secrets: {
            getIndex: async () => ({ MY_KEY: { key: 'MY_KEY' } }),
            getValues: async (_roomId, keys) => {
              const values: Record<string, string> = {};
              if (keys.includes('MY_KEY')) values.MY_KEY = 'user-secret';
              return values;
            },
          },
        },
        runConfig: {
          context: {
            user: {
              did: 'did:ixo:user1',
              matrixUserId: '@did-ixo-user1:ixo.world',
              ucanDelegation: { raw: 'delegation' },
            },
            session: {
              id: 'session-1',
              client: 'matrix',
              requestId: 'req-1',
              roomId: '!room:example.org',
            },
          },
        },
      },
    );
  }

  it('autoDetects on SANDBOX_MCP_URL', () => {
    const plugin = new SandboxPlugin();
    expect(plugin.autoDetect({})).toBe(false);
    expect(plugin.autoDetect({ SANDBOX_MCP_URL: SANDBOX_URL })).toBe(true);
  });

  it('registers upstream tools verbatim, filters oracle_*, adds sandbox_write_blob', async () => {
    const plugin = new SandboxPlugin({ mcpClientFactory: factory });
    const tools = await plugin.getRequestTools(makeCtx());

    expect(tools.map((t) => t.name).sort()).toEqual([
      'sandbox_run',
      'sandbox_write_blob',
      'sandbox_write_file',
    ]);
    expect(tools.find((t) => t.name === 'sandbox_run')?.description).toBe(
      'run code',
    );
  });

  it('mints the full header set: Bearer + X-Auth-Type + X-Skills-Invocation + x-os-* + x-us-*', async () => {
    const plugin = new SandboxPlugin({ mcpClientFactory: factory });
    await plugin.getRequestTools(makeCtx());

    expect(capturedConfigs.length).toBe(1);
    expect(headersOf(capturedConfigs[0])).toEqual({
      Authorization: 'Bearer sandbox-token',
      'X-Auth-Type': 'ucan',
      'X-Skills-Invocation': 'skills-token',
      'x-os-api_key': 'os-value',
      'x-os-other_key': 'second',
      'x-us-my_key': 'user-secret',
    });
  });

  it('proxies a happy-path sandbox_run call through the lazy connection', async () => {
    const plugin = new SandboxPlugin({ mcpClientFactory: factory });
    const ctx = makeCtx();
    const tools = await plugin.getRequestTools(ctx);
    const run = tools.find((t) => t.name === 'sandbox_run');

    const result = await run?.handler({ code: 'echo hi' }, ctx);

    expect(runInvocations).toEqual([{ code: 'echo hi' }]);
    expect(result).toBe(
      JSON.stringify({ success: true, exitCode: 0, output: 'hi' }),
    );
    // Listing client (closed) + the lazy invocation's own client.
    expect(capturedConfigs.length).toBe(2);
  });

  it('sandbox_write_blob resolves the blob server-side and forwards to sandbox_write_file', async () => {
    const plugin = new SandboxPlugin({ mcpClientFactory: factory });
    const ctx = makeCtx();
    const blobId = await ctx.blobStore.put({
      userDid: ctx.user.did,
      name: 'invocation',
      value: 'very-long-opaque-value',
    });
    const tools = await plugin.getRequestTools(ctx);
    const writeBlob = tools.find((t) => t.name === 'sandbox_write_blob');

    const raw = await writeBlob?.handler(
      { blobId, path: '/workspace/data/skill/ucan_token' },
      ctx,
    );
    expect(typeof raw).toBe('string');
    const result: unknown = JSON.parse(typeof raw === 'string' ? raw : '{}');

    expect(result).toMatchObject({
      success: true,
      path: '/workspace/data/skill/ucan_token',
      bytesWritten: 'very-long-opaque-value'.length,
    });
    expect(writeInvocations).toEqual([
      {
        path: '/workspace/data/skill/ucan_token',
        content: 'very-long-opaque-value',
        encoding: 'utf8',
      },
    ]);
  });

  it('contributes no tools (and never connects) when no invocation can be minted', async () => {
    const plugin = new SandboxPlugin({ mcpClientFactory: factory });
    const tools = await plugin.getRequestTools(
      makeCtx({ resolveServiceDid: async () => null }),
    );
    expect(tools).toEqual([]);
    expect(capturedConfigs.length).toBe(0);
  });
});

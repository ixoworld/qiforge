import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createUnsignedUcanAdapter,
  type UcanAdapter,
} from '../../core/runtime-context';
import { makeRuntimeContext } from '../../core/test-fixtures';
import type { RuntimeContext, SessionSurface } from '../../plugin-api/types';
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
  if (!isRecord(config) || !isRecord(config.servers)) {
    throw new Error('factory received a malformed config');
  }
  const server = config.servers.sandbox;
  if (!isRecord(server) || !isRecord(server.headers)) {
    throw new Error('no sandbox server headers');
  }
  return server.headers;
}

describe('SandboxPlugin (Workers port)', () => {
  let capturedConfigs: unknown[];
  let runInvocations: unknown[];
  let writeInvocations: unknown[];
  let secretReads: string[][];
  let upstream: SandboxMcpTool[];
  let factory: SandboxMcpClientFactory;

  beforeEach(() => {
    capturedConfigs = [];
    runInvocations = [];
    writeInvocations = [];
    secretReads = [];
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

  function makeCtx(
    overrides: Partial<UcanAdapter> = {},
    surface?: SessionSurface,
  ): RuntimeContext {
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
            getIndex: async () => ({
              MY_KEY: { key: 'MY_KEY' },
              OTHER_KEY: { key: 'OTHER_KEY' },
            }),
            getValues: async (_roomId, keys) => {
              secretReads.push(keys);
              // Return an over-broad adapter result to prove the plugin still
              // enforces the authorizer's exact name set at its own boundary.
              return {
                MY_KEY: 'user-secret',
                OTHER_KEY: 'unrelated-secret',
              };
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
              ...(surface ? { surface } : {}),
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

  it('discovers tools without reading or forwarding room secrets', async () => {
    const plugin = new SandboxPlugin({ mcpClientFactory: factory });
    await plugin.getRequestTools(makeCtx());

    expect(capturedConfigs.length).toBe(1);
    expect(headersOf(capturedConfigs[0])).toEqual({
      Authorization: 'Bearer sandbox-token',
      'X-Auth-Type': 'ucan',
      'X-Skills-Invocation': 'skills-token',
      'x-os-api_key': 'os-value',
      'x-os-other_key': 'second',
    });
    expect(secretReads).toEqual([]);
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
    expect(secretReads).toEqual([]);
    expect(headersOf(capturedConfigs[1])).not.toHaveProperty('x-us-my_key');
    // Listing client (closed) + the lazy invocation's own client.
    expect(capturedConfigs.length).toBe(2);
  });

  it('scopes host-approved room secrets to one invocation', async () => {
    const authorizerRequests: Array<{
      toolName: string;
      input: unknown;
    }> = [];
    const plugin = new SandboxPlugin({
      mcpClientFactory: factory,
      authorizeUserSecrets: ({ toolName, input }) => {
        authorizerRequests.push({ toolName, input });
        return toolName === 'sandbox_run' ? ['MY_KEY'] : [];
      },
    });
    const ctx = makeCtx();
    const tools = await plugin.getRequestTools(ctx);
    const run = tools.find((t) => t.name === 'sandbox_run');
    const write = tools.find((t) => t.name === 'sandbox_write_file');

    await run?.handler({ code: 'printenv OTHER_KEY' }, ctx);
    await write?.handler({ path: '/workspace/data/a', content: 'a' }, ctx);

    expect(authorizerRequests).toEqual([
      {
        toolName: 'sandbox_run',
        input: { code: 'printenv OTHER_KEY' },
      },
      {
        toolName: 'sandbox_write_file',
        input: { path: '/workspace/data/a', content: 'a' },
      },
    ]);
    expect(secretReads).toEqual([['MY_KEY']]);
    expect(headersOf(capturedConfigs[0])).not.toHaveProperty('x-us-my_key');
    expect(headersOf(capturedConfigs[1])).toMatchObject({
      'x-us-my_key': 'user-secret',
    });
    expect(headersOf(capturedConfigs[1])).not.toHaveProperty('x-us-other_key');
    expect(headersOf(capturedConfigs[2])).not.toHaveProperty('x-us-my_key');
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

  it('sandbox_write_blob reports a returned success:false as a failure', async () => {
    upstream = upstream.map((t) =>
      t.name === 'sandbox_write_file'
        ? {
            ...t,
            invoke: async () =>
              JSON.stringify({ success: false, error: 'path rejected' }),
          }
        : t,
    );
    const plugin = new SandboxPlugin({ mcpClientFactory: factory });
    const ctx = makeCtx();
    const blobId = await ctx.blobStore.put({
      userDid: ctx.user.did,
      name: 'invocation',
      value: 'tok',
    });
    const tools = await plugin.getRequestTools(ctx);
    const raw = await tools
      .find((t) => t.name === 'sandbox_write_blob')
      ?.handler({ blobId, path: '/workspace/data/skill/ucan_token' }, ctx);
    const result: unknown = JSON.parse(typeof raw === 'string' ? raw : '{}');

    expect(result).toMatchObject({ success: false });
    expect(JSON.stringify(result)).toContain('path rejected');
  });

  it('sandbox_write_blob counts bytesWritten in UTF-8 bytes', async () => {
    const plugin = new SandboxPlugin({ mcpClientFactory: factory });
    const ctx = makeCtx();
    const blobId = await ctx.blobStore.put({
      userDid: ctx.user.did,
      name: 'invocation',
      value: 'é€',
    });
    const tools = await plugin.getRequestTools(ctx);
    const raw = await tools
      .find((t) => t.name === 'sandbox_write_blob')
      ?.handler({ blobId, path: '/workspace/data/x' }, ctx);
    const result: unknown = JSON.parse(typeof raw === 'string' ? raw : '{}');

    expect(result).toMatchObject({ success: true, bytesWritten: 5 });
  });

  it('contributes no tools (and never connects) when no invocation can be minted', async () => {
    const plugin = new SandboxPlugin({ mcpClientFactory: factory });
    const tools = await plugin.getRequestTools(
      makeCtx({ resolveServiceDid: async () => null }),
    );
    expect(tools).toEqual([]);
    expect(capturedConfigs.length).toBe(0);
  });
  describe('files on a chat surface', () => {
    const WHATSAPP: SessionSurface = {
      kind: 'chat',
      surface: 'whatsapp',
      label: 'WhatsApp',
    };
    const SIGNED = 'https://r2.example/o/a.pdf?X-Amz-Signature=deadbeef';
    const LOOKUP = JSON.stringify({
      previewUrl: SIGNED,
      downloadUrl: SIGNED,
      url: SIGNED,
      path: '/output/a.pdf',
      filename: 'a.pdf',
      expiresIn: 10_800,
    });
    const LIST = JSON.stringify({
      artifacts: [{ path: '/output/a.pdf', size: 3 }],
      nextCursor: null,
    });
    const artifactTools: SandboxMcpTool[] = [
      ...[
        ['artifact_get_presigned_url', LOOKUP],
        ['artifact_get_by_path', LOOKUP],
        ['artifact_get_by_cid', LOOKUP],
        ['artifact_list', LIST],
        ['load_artifact', JSON.stringify({ path: '/w/a.pdf', size: 3 })],
      ].map(([name, result]) => ({
        name: name as string,
        description: `${name} tool`,
        schema: z.object({}),
        invoke: async () => result,
      })),
    ];

    const names = (tools: { name: string }[]): string[] =>
      tools.map((t) => t.name);

    it('binds send_file and hides the signing tool on a chat surface', async () => {
      upstream = [...upstream, ...artifactTools];
      const plugin = new SandboxPlugin({ mcpClientFactory: factory });
      const tools = await plugin.getRequestTools(makeCtx({}, WHATSAPP));
      expect(names(tools)).toContain('send_file');
      expect(names(tools)).not.toContain('artifact_get_presigned_url');
      // The warm path goes through the same tail.
      const warm = await plugin.getRequestTools(makeCtx({}, WHATSAPP));
      expect(names(warm)).toEqual(names(tools));
    });

    it('leaves the Portal, and every surface that is not chat, as it was', async () => {
      upstream = [...upstream, ...artifactTools];
      for (const surface of [{ kind: 'stream' } as const, undefined]) {
        const plugin = new SandboxPlugin({ mcpClientFactory: factory });
        const tools = await plugin.getRequestTools(makeCtx({}, surface));
        expect(names(tools)).not.toContain('send_file');
        expect(names(tools)).toContain('artifact_get_presigned_url');
        for (const name of [
          'artifact_get_presigned_url',
          'artifact_get_by_path',
          'artifact_get_by_cid',
        ]) {
          const tool = tools.find((t) => t.name === name);
          expect(tool?.description).toBe(`${name} tool`);
          expect(await tool?.handler({}, makeCtx())).toBe(LOOKUP);
        }
        const list = tools.find((t) => t.name === 'artifact_list');
        expect(await list?.handler({}, makeCtx())).toBe(LIST);
      }
    });

    it('strips the URL fields of every lookup before the model sees them', async () => {
      upstream = [...upstream, ...artifactTools];
      const plugin = new SandboxPlugin({ mcpClientFactory: factory });
      const ctx = makeCtx({}, WHATSAPP);
      const tools = await plugin.getRequestTools(ctx);
      for (const name of ['artifact_get_by_path', 'artifact_get_by_cid']) {
        const tool = tools.find((t) => t.name === name);
        const result = await tool?.handler({}, ctx);
        expect(JSON.parse(result as string)).toEqual({
          path: '/output/a.pdf',
          filename: 'a.pdf',
        });
        expect(tool?.description).toContain('`send_file`');
      }
      const list = tools.find((t) => t.name === 'artifact_list');
      expect(JSON.parse((await list?.handler({}, ctx)) as string)).toEqual({
        artifacts: [{ path: '/output/a.pdf', size: 3 }],
        nextCursor: null,
      });
      const load = tools.find((t) => t.name === 'load_artifact');
      expect(load?.description).toBe('load_artifact tool');
    });

    it('signs through the upstream tool it hides', async () => {
      upstream = [...upstream, ...artifactTools];
      const plugin = new SandboxPlugin({ mcpClientFactory: factory });
      const ctx = makeCtx({}, WHATSAPP);
      const tools = await plugin.getRequestTools(ctx);
      const sendFile = tools.find((t) => t.name === 'send_file');
      const message = await sendFile?.handler({ path: '/output/a.pdf' }, ctx);
      expect(message).toMatchObject({
        artifact: { url: SIGNED, filename: 'a.pdf' },
      });
    });

    it('does not promise an attachment in a Matrix room', async () => {
      upstream = [...upstream, ...artifactTools];
      const plugin = new SandboxPlugin({ mcpClientFactory: factory });
      const tools = await plugin.getRequestTools(
        makeCtx(
          {},
          { kind: 'chat', surface: 'matrix', label: 'a Matrix chat room' },
        ),
      );
      const sendFile = tools.find((t) => t.name === 'send_file');
      expect(sendFile?.description).not.toContain('attachment');
    });

    it('offers no send_file when the sandbox cannot sign', async () => {
      const plugin = new SandboxPlugin({ mcpClientFactory: factory });
      const tools = await plugin.getRequestTools(makeCtx({}, WHATSAPP));
      expect(names(tools)).not.toContain('send_file');
    });
  });
});

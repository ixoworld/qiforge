import { describe, expect, it } from 'vitest';
import {
  createUnsignedUcanAdapter,
  type UcanAdapter,
} from '../../core/runtime-context';
import { makeRuntimeContext } from '../../core/test-fixtures';
import type { RuntimeContext } from '../../plugin-api/types';
import { createVfsTools } from './vfs-tools';
import { VfsPlugin, type VfsConfig } from './vfs.plugin';

const VFS_TOOL_NAMES = [
  'vfs_search',
  'vfs_grep',
  'vfs_glob',
  'vfs_list',
  'vfs_read',
  'vfs_write',
  'vfs_edit',
  'vfs_move',
  'vfs_delete',
  'vfs_share',
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function headerOf(init: RequestInit | undefined, name: string): unknown {
  const headers = init?.headers;
  if (!isRecord(headers)) return undefined;
  return headers[name];
}

interface RecordedFetch {
  url: string;
  init?: RequestInit;
}

function makeSignedCtx(
  config: Record<string, unknown>,
  ucanOverrides: Partial<UcanAdapter> = {},
): RuntimeContext {
  const ucan: UcanAdapter = {
    ...createUnsignedUcanAdapter(),
    hasSigningKey: () => true,
    getServiceDelegation: async () => ({
      token: 'delegation-car',
      with: 'wid:user-root',
    }),
    createInvocationFromDelegation: async () => ({
      invocation: 'vfs-inv-token',
    }),
    ...ucanOverrides,
  };
  return makeRuntimeContext({}, { ambient: { ucan, config } });
}

describe('VfsPlugin (Workers port)', () => {
  it('self-gates on the oracle signing key', () => {
    const plugin = new VfsPlugin();
    const ctx = makeRuntimeContext(
      {},
      { ambient: { config: { NETWORK: 'devnet' } } }, // unsigned UCAN adapter
    );
    expect(plugin.getRequestTools(ctx)).toEqual([]);
  });

  it('registers the ten file tools; search/read stay always-visible', () => {
    const plugin = new VfsPlugin();
    const tools = plugin.getRequestTools(makeSignedCtx({ NETWORK: 'devnet' }));

    expect(tools.map((t) => t.name)).toEqual(VFS_TOOL_NAMES);
    expect(tools.find((t) => t.name === 'vfs_search')?.visibility).toBe(
      'always',
    );
    expect(tools.find((t) => t.name === 'vfs_read')?.visibility).toBe('always');
    expect(
      tools.find((t) => t.name === 'vfs_write')?.visibility,
    ).toBeUndefined();
  });

  it('adds the two sandbox bridge tools only when SANDBOX_MCP_URL is set', () => {
    const plugin = new VfsPlugin();
    const tools = plugin.getRequestTools(
      makeSignedCtx({
        NETWORK: 'devnet',
        SANDBOX_MCP_URL: 'https://sandbox.example/mcp',
      }),
    );
    expect(tools.map((t) => t.name)).toEqual([
      ...VFS_TOOL_NAMES,
      'sandbox_to_vfs',
      'vfs_to_sandbox',
    ]);
  });

  describe('tools over a mocked transport', () => {
    const cfg: VfsConfig = {
      VFS_BASE_URL: 'https://vfs.example',
      UCAN_STORE_URL: 'https://store.example',
      VFS_MAX_READ_LINES: 2000,
      VFS_REQUEST_TIMEOUT_MS: 20000,
    };

    function makeTransport(respond: (call: RecordedFetch) => Response): {
      calls: RecordedFetch[];
      fetchImpl: typeof fetch;
    } {
      const calls: RecordedFetch[] = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        const call: RecordedFetch = { url: String(input), init };
        calls.push(call);
        return respond(call);
      };
      return { calls, fetchImpl };
    }

    it('vfs_list mints a two-hop bearer and calls /api/fs/tree with the UCAN header shape', async () => {
      const delegationCalls: Array<{
        userDid: string;
        opts: { storeUrl: string; resource: string; requiredAbility: string };
      }> = [];
      const invocationCalls: Array<{
        car: string;
        serviceUrl: string;
        capability: { can: string; with: string };
      }> = [];
      const ctx = makeSignedCtx(
        { ORACLE_DID: 'did:ixo:oracle1' },
        {
          getServiceDelegation: async (userDid, opts) => {
            delegationCalls.push({ userDid, opts });
            return { token: 'delegation-car', with: 'wid:user-root' };
          },
          createInvocationFromDelegation: async (
            car,
            serviceUrl,
            capability,
          ) => {
            invocationCalls.push({ car, serviceUrl, capability });
            return { invocation: 'vfs-inv-token' };
          },
        },
      );
      const { calls, fetchImpl } = makeTransport(
        () =>
          new Response(
            JSON.stringify({
              nodes: [
                { path: '/notes', name: 'notes', type: 'folder' },
                { path: '/a.md', name: 'a.md', type: 'file', id: 'f1' },
              ],
            }),
            { status: 200 },
          ),
      );
      const tools = createVfsTools({ cfg, fetchImpl, retryDelayMs: 0 });
      const list = tools.find((t) => t.name === 'vfs_list');

      const result = await list?.handler({ path: '/' }, ctx);

      expect(result).toBe('Contents of `/`:\n- /notes/\n- /a.md');

      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe('https://vfs.example/api/fs/tree?path=%2F');
      expect(headerOf(calls[0]?.init, 'authorization')).toBe(
        'Bearer vfs-inv-token',
      );
      expect(headerOf(calls[0]?.init, 'x-auth-type')).toBe('ucan');

      // Hop 1: the user's deposited delegation over ixo:filesystem.
      expect(delegationCalls).toEqual([
        {
          userDid: 'did:ixo:user1',
          opts: {
            storeUrl: 'https://store.example',
            resource: 'ixo:filesystem',
            requiredAbility: 'fs/list',
          },
        },
      ]);
      // Hop 2: a single-use invocation proved by it, attenuated to the ability.
      expect(invocationCalls).toEqual([
        {
          car: 'delegation-car',
          serviceUrl: 'https://vfs.example',
          capability: { can: 'fs/list', with: 'wid:user-root' },
        },
      ]);
    });

    it('vfs_read renders the numbered text window', async () => {
      const ctx = makeSignedCtx({});
      const { calls, fetchImpl } = makeTransport((call) => {
        if (call.url.includes('/glob?')) {
          return new Response(
            JSON.stringify({
              files: [
                {
                  id: 'f1',
                  path: '/a.md',
                  name: 'a.md',
                  mimeType: 'text/markdown',
                  size: 12,
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            text: '     1\thello',
            offset: 1,
            count: 1,
            hasMore: false,
            totalLines: 1,
          }),
          { status: 200 },
        );
      });
      const tools = createVfsTools({ cfg, fetchImpl, retryDelayMs: 0 });
      const read = tools.find((t) => t.name === 'vfs_read');

      const result = await read?.handler({ path: '/a.md' }, ctx);

      expect(result).toBe('     1\thello');
      expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
        '/api/fs/glob',
        '/api/fs/files/f1/read',
      ]);
    });

    it('degrades to the grant-access guidance (with the oracle DID) when no delegation exists', async () => {
      const ctx = makeSignedCtx(
        { ORACLE_DID: 'did:ixo:oracle1' },
        { getServiceDelegation: async () => ({ error: 'no-delegation' }) },
      );
      const { calls, fetchImpl } = makeTransport(
        () => new Response('{}', { status: 200 }),
      );
      const tools = createVfsTools({ cfg, fetchImpl, retryDelayMs: 0 });
      const list = tools.find((t) => t.name === 'vfs_list');

      const result = await list?.handler({ path: '/' }, ctx);

      expect(typeof result).toBe('string');
      expect(result).toContain("I don't have access to your files yet");
      expect(result).toContain('My agent DID: did:ixo:oracle1');
      expect(calls).toHaveLength(0);
    });
  });
});

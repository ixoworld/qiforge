import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createUnsignedUcanAdapter,
  type UcanAdapter,
} from '../../core/runtime-context';
import { makeRuntimeContext } from '../../core/test-fixtures';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types';
import type {
  SandboxMcpClientFactory,
  SandboxMcpTool,
} from '../sandbox/sandbox.plugin';
import { MAX_VISION_BYTES } from './vfs-content';
import { createVfsSandboxTools } from './vfs-sandbox-tools';
import {
  createVfsTools,
  validatePath,
  VFS_DELETE_MAX_PATHS,
  VFS_PATH_LOOKUP_CONCURRENCY,
} from './vfs-tools';
import type { VfsConfig } from './vfs.plugin';

const cfg: VfsConfig = {
  VFS_BASE_URL: 'https://vfs.example',
  UCAN_STORE_URL: 'https://store.example',
  VFS_MAX_READ_LINES: 2000,
  VFS_REQUEST_TIMEOUT_MS: 20000,
};

/** Two private files that the wildcard `/private/*` matches; neither is named `*`. */
const PRIVATE_FILES = [
  { id: 'p1', path: '/private/diary.md', mimeType: 'text/markdown', size: 10 },
  { id: 'p2', path: '/private/keys.txt', mimeType: 'text/plain', size: 10 },
];

interface Call {
  method: string;
  pathname: string;
  search: URLSearchParams;
}

function makeCtx(): RuntimeContext {
  const ucan: UcanAdapter = {
    ...createUnsignedUcanAdapter(),
    hasSigningKey: () => true,
    getServiceDelegation: async () => ({ token: 'car', with: 'wid:root' }),
    createInvocationFromDelegation: async () => ({ invocation: 'inv' }),
    resolveServiceDid: async () => 'did:web:sandbox.example',
    mintInvocation: async () => 'sandbox-token',
  };
  return makeRuntimeContext({}, { ambient: { ucan, config: {} } });
}

/**
 * A VFS stub: `/glob` answers with every file the pattern-as-glob would
 * match (as the worker does), everything else with a generic success.
 */
function makeVfs(
  files: Array<{ id: string; path: string; mimeType?: string; size?: number }>,
  overrides: (call: Call) => Response | undefined = () => undefined,
) {
  const calls: Call[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? 'GET',
      pathname: url.pathname.replace('/api/fs', ''),
      search: url.searchParams,
    };
    calls.push(call);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight -= 1;
    const custom = overrides(call);
    if (custom) return custom;
    if (call.pathname === '/glob') {
      const pattern = url.searchParams.get('pattern') ?? '';
      const re = new RegExp(
        `^${pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '[^/]*')
          .replace(/\?/g, '[^/]')}$`,
      );
      return Response.json({ files: files.filter((f) => re.test(f.path)) });
    }
    if (call.pathname.startsWith('/batch/')) {
      return Response.json({ results: [{ id: 'x', ok: true, status: 200 }] });
    }
    return Response.json({ public: true, publicUrl: 'https://pub.example/x' });
  };
  return {
    calls,
    fetchImpl,
    maxInFlight: () => maxInFlight,
    writes: () => calls.filter((c) => c.method !== 'GET'),
  };
}

function toolNamed(tools: PluginTool[], name: string): PluginTool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

describe('VFS tools never act on a file a wildcard path merely matches', () => {
  it('vfs_share("/private/*") publishes nothing', async () => {
    const vfs = makeVfs(PRIVATE_FILES);
    const tools = createVfsTools({
      cfg,
      fetchImpl: vfs.fetchImpl,
      retryDelayMs: 0,
    });
    const out = await toolNamed(tools, 'vfs_share').handler(
      { path: '/private/*' },
      makeCtx(),
    );
    expect(out).toContain('No file at `/private/*`');
    expect(vfs.writes()).toEqual([]);
  });

  it('vfs_delete(["/private/*"]) trashes nothing', async () => {
    const vfs = makeVfs(PRIVATE_FILES);
    const tools = createVfsTools({
      cfg,
      fetchImpl: vfs.fetchImpl,
      retryDelayMs: 0,
    });
    const out = await toolNamed(tools, 'vfs_delete').handler(
      { paths: ['/private/*'] },
      makeCtx(),
    );
    expect(out).toContain('No such file(s): /private/*');
    expect(vfs.writes()).toEqual([]);
  });

  it('vfs_edit("/private/?iary.md") edits nothing', async () => {
    const vfs = makeVfs(PRIVATE_FILES);
    const tools = createVfsTools({
      cfg,
      fetchImpl: vfs.fetchImpl,
      retryDelayMs: 0,
    });
    await toolNamed(tools, 'vfs_edit').handler(
      { path: '/private/?iary.md', oldString: 'a', newString: 'b' },
      makeCtx(),
    );
    expect(vfs.writes()).toEqual([]);
  });

  it('vfs_move("/private/*") moves nothing and says folders/wildcards are not accepted', async () => {
    const vfs = makeVfs(PRIVATE_FILES);
    const tools = createVfsTools({
      cfg,
      fetchImpl: vfs.fetchImpl,
      retryDelayMs: 0,
    });
    const out = await toolNamed(tools, 'vfs_move').handler(
      { from: '/private/*', to: '/public/leak.md' },
      makeCtx(),
    );
    expect(out).toContain('No file at `/private/*` to move');
    expect(out).toContain('folders and wildcard patterns are not accepted');
    expect(vfs.writes()).toEqual([]);
  });

  it('vfs_move on a folder path is refused with the files-only note', async () => {
    const vfs = makeVfs(PRIVATE_FILES);
    const tools = createVfsTools({
      cfg,
      fetchImpl: vfs.fetchImpl,
      retryDelayMs: 0,
    });
    const out = await toolNamed(tools, 'vfs_move').handler(
      { from: '/private', to: '/archive' },
      makeCtx(),
    );
    expect(out).toContain('folders and wildcard patterns are not accepted');
    expect(vfs.writes()).toEqual([]);
  });

  it('a real file whose name contains "?" is still shared', async () => {
    const vfs = makeVfs([
      { id: 'q1', path: '/notes/why?.md' },
      { id: 'q2', path: '/notes/whyX.md' },
    ]);
    const tools = createVfsTools({
      cfg,
      fetchImpl: vfs.fetchImpl,
      retryDelayMs: 0,
    });
    await toolNamed(tools, 'vfs_share').handler(
      { path: '/notes/why?.md' },
      makeCtx(),
    );
    expect(vfs.writes().map((c) => c.pathname)).toEqual(['/files/q1/public']);
  });

  it('vfs_to_sandbox("/private/*", deleteSource) neither copies nor trashes', async () => {
    const vfs = makeVfs(PRIVATE_FILES);
    const writes: unknown[] = [];
    const tools = createVfsSandboxTools(
      {
        vfsCfg: cfg,
        sandboxMcpUrl: 'https://sandbox.example/mcp',
        vfsFetchImpl: vfs.fetchImpl,
        vfsRetryDelayMs: 0,
      },
      sandboxFactory(writes),
    );
    const out = await toolNamed(tools, 'vfs_to_sandbox').handler(
      {
        vfsPath: '/private/*',
        sandboxPath: '/workspace/data/in/x',
        deleteSource: true,
      },
      makeCtx(),
    );
    expect(out).toBe('No such file at `/private/*`.');
    expect(vfs.calls.map((c) => c.pathname)).toEqual(['/glob']);
    expect(writes).toEqual([]);
  });
});

describe('vfs_delete bounds its lookups', () => {
  it(`rejects more than ${VFS_DELETE_MAX_PATHS} paths before any request`, async () => {
    const vfs = makeVfs([]);
    const tools = createVfsTools({
      cfg,
      fetchImpl: vfs.fetchImpl,
      retryDelayMs: 0,
    });
    const paths = Array.from(
      { length: VFS_DELETE_MAX_PATHS + 1 },
      (_, i) => `/f${i}.md`,
    );
    const out = await toolNamed(tools, 'vfs_delete').handler(
      { paths },
      makeCtx(),
    );
    expect(out).toMatch(/^Invalid arguments: paths/);
    expect(vfs.calls).toEqual([]);
  });

  it(`keeps at most ${VFS_PATH_LOOKUP_CONCURRENCY} lookups in flight and trashes once`, async () => {
    const files = Array.from({ length: 20 }, (_, i) => ({
      id: `id${i}`,
      path: `/f${i}.md`,
    }));
    const vfs = makeVfs(files);
    const tools = createVfsTools({
      cfg,
      fetchImpl: vfs.fetchImpl,
      retryDelayMs: 0,
    });
    await toolNamed(tools, 'vfs_delete').handler(
      { paths: files.map((f) => f.path) },
      makeCtx(),
    );
    expect(vfs.calls.filter((c) => c.pathname === '/glob')).toHaveLength(20);
    expect(vfs.maxInFlight()).toBeLessThanOrEqual(VFS_PATH_LOOKUP_CONCURRENCY);
    expect(vfs.writes().map((c) => c.pathname)).toEqual(['/batch/delete']);
  });

  it('looks a repeated path up once', async () => {
    const vfs = makeVfs([{ id: 'a', path: '/a.md' }]);
    const tools = createVfsTools({
      cfg,
      fetchImpl: vfs.fetchImpl,
      retryDelayMs: 0,
    });
    await toolNamed(tools, 'vfs_delete').handler(
      { paths: ['/a.md', '/a.md', '/a.md'] },
      makeCtx(),
    );
    expect(vfs.calls.filter((c) => c.pathname === '/glob')).toHaveLength(1);
  });
});

describe('vfs_read size cap on binaries', () => {
  it('never downloads an image whose stored size exceeds the vision cap', async () => {
    const vfs = makeVfs([
      {
        id: 'big',
        path: '/big.png',
        mimeType: 'image/png',
        size: 50 * 1024 * 1024,
      },
    ]);
    const tools = createVfsTools({
      cfg,
      fetchImpl: vfs.fetchImpl,
      retryDelayMs: 0,
    });
    const out = await toolNamed(tools, 'vfs_read').handler(
      { path: '/big.png' },
      makeCtx(),
    );
    expect(out).toContain('too large to render');
    expect(out).toContain(`limit ${MAX_VISION_BYTES} bytes`);
    expect(vfs.calls.map((c) => c.pathname)).toEqual(['/glob']);
  });

  it('never downloads a binary type the vision model does not take', async () => {
    const vfs = makeVfs([
      { id: 'z', path: '/a.zip', mimeType: 'application/zip', size: 100 },
    ]);
    const tools = createVfsTools({
      cfg,
      fetchImpl: vfs.fetchImpl,
      retryDelayMs: 0,
    });
    const out = await toolNamed(tools, 'vfs_read').handler(
      { path: '/a.zip' },
      makeCtx(),
    );
    expect(out).toContain('not rendered');
    expect(vfs.calls.map((c) => c.pathname)).toEqual(['/glob']);
  });

  it('stops a download whose real size exceeds the cap when the stored size is unknown', async () => {
    const vfs = makeVfs(
      [{ id: 'u', path: '/u.png', mimeType: 'image/png' }],
      (call) =>
        call.pathname === '/files/u/content'
          ? new Response('x', {
              headers: { 'content-length': String(MAX_VISION_BYTES + 1) },
            })
          : undefined,
    );
    const tools = createVfsTools({
      cfg,
      fetchImpl: vfs.fetchImpl,
      retryDelayMs: 0,
    });
    const out = await toolNamed(tools, 'vfs_read').handler(
      { path: '/u.png' },
      makeCtx(),
    );
    expect(out).toContain('too large to render');
  });
});

/** A sandbox MCP stub whose `sandbox_write_file` records what it was sent. */
function sandboxFactory(writes: unknown[]): SandboxMcpClientFactory {
  const tools: SandboxMcpTool[] = [
    {
      name: 'sandbox_run',
      description: '',
      schema: z.object({ code: z.string() }),
      invoke: async () =>
        JSON.stringify({ success: true, exitCode: 0, output: '' }),
    },
    {
      name: 'sandbox_write_file',
      description: '',
      schema: z.object({}),
      invoke: async (input: unknown) => {
        writes.push(input);
        return JSON.stringify({ success: true });
      },
    },
  ];
  return () => ({ getTools: async () => tools, close: async () => undefined });
}

describe('vfs_to_sandbox transfer', () => {
  it('delivers a non-UTF-8 text file byte for byte (always base64)', async () => {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "café\n" in Latin-1
    const vfs = makeVfs(
      [
        {
          id: 'c',
          path: '/data.csv',
          mimeType: 'text/csv',
          size: latin1.length,
        },
      ],
      (call) =>
        call.pathname === '/files/c/content'
          ? new Response(latin1, { headers: { 'content-type': 'text/csv' } })
          : undefined,
    );
    const writes: unknown[] = [];
    const tools = createVfsSandboxTools(
      {
        vfsCfg: cfg,
        sandboxMcpUrl: 'https://sandbox.example/mcp',
        vfsFetchImpl: vfs.fetchImpl,
        vfsRetryDelayMs: 0,
      },
      sandboxFactory(writes),
    );
    await toolNamed(tools, 'vfs_to_sandbox').handler(
      { vfsPath: '/data.csv', sandboxPath: '/workspace/data/in/data.csv' },
      makeCtx(),
    );
    expect(writes).toHaveLength(1);
    const sent = z
      .object({ content: z.string(), encoding: z.literal('base64') })
      .parse(writes[0]);
    const bytes = Uint8Array.from(atob(sent.content), (ch) => ch.charCodeAt(0));
    expect([...bytes]).toEqual([...latin1]);
  });

  it('refuses a file over the transfer cap without downloading it', async () => {
    const vfs = makeVfs([
      {
        id: 'b',
        path: '/big.bin',
        mimeType: 'application/octet-stream',
        size: 50 * 1024 * 1024,
      },
    ]);
    const writes: unknown[] = [];
    const tools = createVfsSandboxTools(
      {
        vfsCfg: cfg,
        sandboxMcpUrl: 'https://sandbox.example/mcp',
        vfsFetchImpl: vfs.fetchImpl,
        vfsRetryDelayMs: 0,
      },
      sandboxFactory(writes),
    );
    const out = await toolNamed(tools, 'vfs_to_sandbox').handler(
      { vfsPath: '/big.bin', sandboxPath: '/workspace/data/in/big.bin' },
      makeCtx(),
    );
    expect(out).toContain('limited to 10485760 bytes');
    expect(vfs.calls.map((c) => c.pathname)).toEqual(['/glob']);
    expect(writes).toEqual([]);
  });
});

describe('validatePath', () => {
  it.each([
    ['', 'path is required'],
    ['relative/x', 'path must be absolute'],
    ['/a/../b', '"." or ".."'],
    ['/a/./b', '"." or ".."'],
    ['/..', '"." or ".."'],
    ['/a//b', '"//"'],
    ['/a/b/', 'must not end with "/"'],
    ['/a\0b', 'null byte'],
    [`/${'x'.repeat(1024)}`, 'at most 1024'],
  ])('rejects %j', (path, fragment) => {
    expect(validatePath(path)).toContain(fragment);
  });

  it.each(['/', '/a', '/a/b.md', '/..a/b', '/a/...', `/${'x'.repeat(1023)}`])(
    'accepts %j',
    (path) => {
      expect(validatePath(path)).toBeNull();
    },
  );

  it('passes percent-encoded separators through as literal characters, never as traversal', async () => {
    expect(validatePath('/a%2F..%2Fb')).toBeNull();
    const vfs = makeVfs([]);
    const tools = createVfsTools({
      cfg,
      fetchImpl: vfs.fetchImpl,
      retryDelayMs: 0,
    });
    await toolNamed(tools, 'vfs_list').handler(
      { path: '/a%2F..%2Fb' },
      makeCtx(),
    );
    // The worker decodes the query once and sees the literal name.
    expect(vfs.calls[0]?.search.get('path')).toBe('/a%2F..%2Fb');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types.js';
import { makeRuntimeContext } from '../../registries/test-fixtures.js';
import type {
  SandboxMcpClientFactory,
  SandboxMcpTool,
} from '../sandbox/sandbox.plugin.js';
import {
  createVfsSandboxTools,
  type CreateVfsSandboxToolsDeps,
} from './vfs-sandbox-tools.js';
import type { VfsConfig } from './vfs.plugin.js';

const VFS_URL = 'https://vfs.test';
const STORE_URL = 'https://ucan.test';
const SANDBOX_URL = 'https://sandbox.test';

function vfsCfg(): VfsConfig {
  return {
    VFS_BASE_URL: VFS_URL,
    UCAN_STORE_URL: STORE_URL,
    VFS_MAX_READ_LINES: 2000,
    VFS_REQUEST_TIMEOUT_MS: 20000,
  };
}

// ---------------------------------------------------------------------------
// Fake VFS transport
// ---------------------------------------------------------------------------

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function bytesRes(status: number, data: Uint8Array, mime: string): Response {
  return new Response(data, { status, headers: { 'content-type': mime } });
}

interface RecordedCall {
  url: string;
  method: string;
  body?: unknown;
  headers: Record<string, string>;
}

type RouteHandler = (
  url: string,
  init: RequestInit,
) => Response | Promise<Response>;

function makeFetch(handler: RouteHandler): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw && !Array.isArray(raw) && !(raw instanceof Headers)) {
      for (const [k, v] of Object.entries(raw)) headers[k] = String(v);
    }
    calls.push({ url, method, body: init?.body ?? undefined, headers });
    return handler(url, init ?? {});
  };
  return { fetchImpl, calls };
}

/** Decode a recorded fetch body (string / ArrayBuffer / Uint8Array) to bytes. */
function bodyToBuffer(body: unknown): Buffer {
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw new Error(
    `unexpected body type: ${Object.prototype.toString.call(body)}`,
  );
}

// ---------------------------------------------------------------------------
// Fake sandbox MCP client
// ---------------------------------------------------------------------------

function envelope(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

interface SandboxFactoryOpts {
  run?: (input: unknown) => Promise<unknown>;
  writeFile?: (input: unknown) => Promise<unknown>;
  tools?: string[];
}

function makeSandboxFactory(opts: SandboxFactoryOpts = {}) {
  const runInvoke = vi.fn(
    opts.run ??
      (async () => envelope({ success: true, exitCode: 0, output: '' })),
  );
  const writeInvoke = vi.fn(
    opts.writeFile ?? (async () => envelope({ success: true })),
  );
  const closeSpy = vi.fn(async () => undefined);
  const exposed = opts.tools ?? ['sandbox_run', 'sandbox_write_file'];
  let factoryCalls = 0;
  const factory: SandboxMcpClientFactory = () => {
    factoryCalls += 1;
    return {
      getTools: async () => {
        const out: SandboxMcpTool[] = [];
        if (exposed.includes('sandbox_run')) {
          out.push({
            name: 'sandbox_run',
            description: 'run',
            schema: z.object({ code: z.string() }),
            invoke: runInvoke,
          });
        }
        if (exposed.includes('sandbox_write_file')) {
          out.push({
            name: 'sandbox_write_file',
            description: 'write',
            schema: z.object({
              path: z.string(),
              content: z.string(),
              encoding: z.string().optional(),
            }),
            invoke: writeInvoke,
          });
        }
        return out;
      },
      close: closeSpy,
    };
  };
  return {
    factory,
    runInvoke,
    writeInvoke,
    closeSpy,
    factoryCalls: () => factoryCalls,
  };
}

// ---------------------------------------------------------------------------
// Runtime context
// ---------------------------------------------------------------------------

function ucanStub(
  overrides: Partial<RuntimeContext['ucan']> = {},
): RuntimeContext['ucan'] {
  return {
    requireCapability: () => undefined,
    hasCapability: () => true,
    mintInvocation: async () => 'sandbox-inv',
    resolveServiceDid: async () => 'did:web:sandbox.test',
    hasSigningKey: () => true,
    createInvocationFromDelegation: async () => ({ invocation: 'vfs-bearer' }),
    mintSelfSignedInvocation: async () => ({ invocation: 'x' }),
    getServiceDelegation: async () => ({
      token: 'del',
      with: 'ixo:filesystem',
    }),
    ...overrides,
  };
}

function makeCtx(ucan: RuntimeContext['ucan'] = ucanStub()): RuntimeContext {
  return makeRuntimeContext({
    config: { VFS_BASE_URL: VFS_URL, UCAN_STORE_URL: STORE_URL },
    user: {
      did: 'did:ixo:alice',
      matrixUserId: '@alice:ixo.world',
      ucanDelegation: { raw: 'x' },
    },
    ucan,
  });
}

function makeDeps(fetchImpl: typeof fetch): CreateVfsSandboxToolsDeps {
  return {
    vfsCfg: vfsCfg(),
    sandboxMcpUrl: SANDBOX_URL,
    vfsFetchImpl: fetchImpl,
    vfsRetryDelayMs: 0,
  };
}

function getTool(
  name: string,
  deps: CreateVfsSandboxToolsDeps,
  factory: SandboxMcpClientFactory,
): PluginTool {
  const t = createVfsSandboxTools(deps, factory).find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

// ---------------------------------------------------------------------------
// sandbox_to_vfs
// ---------------------------------------------------------------------------

describe('sandbox_to_vfs', () => {
  it('reads the sandbox file (base64), writes decoded bytes + inferred mime to the VFS', async () => {
    const payload = 'hello world';
    const sandbox = makeSandboxFactory({
      run: async () =>
        envelope({
          success: true,
          exitCode: 0,
          output: Buffer.from(payload).toString('base64'),
        }),
    });
    const { fetchImpl, calls } = makeFetch(() =>
      jsonRes(200, { id: 'f1', path: '/reports/note.md' }),
    );

    const res = await getTool(
      'sandbox_to_vfs',
      makeDeps(fetchImpl),
      sandbox.factory,
    ).handler(
      { sandboxPath: '/workspace/output/note.md', vfsPath: '/reports/note.md' },
      makeCtx(),
    );

    // The read command used base64, never surfacing the bytes to the model.
    const runArg = sandbox.runInvoke.mock.calls[0]?.[0] as { code: string };
    expect(runArg.code).toContain('base64');
    expect(runArg.code).toContain('/workspace/output/note.md');

    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toContain('/files?path=');
    expect(post?.headers['content-type']).toBe('text/markdown');
    expect(bodyToBuffer(post?.body).toString('utf8')).toBe(payload);

    const out = JSON.parse(res as string);
    expect(out).toMatchObject({
      ok: true,
      vfsPath: '/reports/note.md',
      bytes: payload.length,
      cid: 'f1',
      movedFromSandbox: '/workspace/output/note.md',
      deletedSource: false,
    });
    expect(sandbox.closeSpy).toHaveBeenCalledTimes(1);
  });

  it('infers an image mime from the vfs extension', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const sandbox = makeSandboxFactory({
      run: async () =>
        envelope({
          success: true,
          exitCode: 0,
          output: bytes.toString('base64'),
        }),
    });
    const { fetchImpl, calls } = makeFetch(() =>
      jsonRes(200, { id: 'i1', path: '/pics/logo.png' }),
    );

    await getTool(
      'sandbox_to_vfs',
      makeDeps(fetchImpl),
      sandbox.factory,
    ).handler(
      { sandboxPath: '/workspace/output/logo.png', vfsPath: '/pics/logo.png' },
      makeCtx(),
    );

    const post = calls.find((c) => c.method === 'POST');
    expect(post?.headers['content-type']).toBe('image/png');
    expect(bodyToBuffer(post?.body).equals(bytes)).toBe(true);
  });

  it('returns a not-found message when the sandbox file is absent (bare sentinel)', async () => {
    const sandbox = makeSandboxFactory({
      // Bare (non-JSON) stdout — exercises the string fallback.
      run: async () => '__VFS_NOFILE__\n',
    });
    const { fetchImpl, calls } = makeFetch(() => jsonRes(200, {}));

    const res = await getTool(
      'sandbox_to_vfs',
      makeDeps(fetchImpl),
      sandbox.factory,
    ).handler(
      { sandboxPath: '/workspace/output/missing.txt', vfsPath: '/x.txt' },
      makeCtx(),
    );

    expect(res).toBe(
      'No file at `/workspace/output/missing.txt` in the sandbox.',
    );
    expect(calls).toHaveLength(0);
    expect(sandbox.closeSpy).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite an existing VFS file unless overwrite is set', async () => {
    const sandbox = makeSandboxFactory({
      run: async () =>
        envelope({
          success: true,
          exitCode: 0,
          output: Buffer.from('x').toString('base64'),
        }),
    });
    const { fetchImpl } = makeFetch(() =>
      jsonRes(409, { error: 'File already exists' }),
    );

    const res = await getTool(
      'sandbox_to_vfs',
      makeDeps(fetchImpl),
      sandbox.factory,
    ).handler(
      { sandboxPath: '/workspace/output/a.txt', vfsPath: '/a.txt' },
      makeCtx(),
    );

    expect(res).toContain('already exists at `/a.txt`');
    expect(res).toContain('set overwrite');
  });

  it('replaces the existing VFS file when overwrite is true', async () => {
    const sandbox = makeSandboxFactory({
      run: async () =>
        envelope({
          success: true,
          exitCode: 0,
          output: Buffer.from('new').toString('base64'),
        }),
    });
    const { fetchImpl, calls } = makeFetch((url, init) => {
      if (url.includes('/files?path=') && init.method === 'POST') {
        return jsonRes(409, { error: 'File already exists' });
      }
      if (url.includes('/glob')) {
        return jsonRes(200, {
          files: [{ id: 'f9', path: '/a.txt', mimeType: 'text/plain' }],
        });
      }
      if (init.method === 'PUT')
        return jsonRes(200, { id: 'f9', path: '/a.txt' });
      return jsonRes(404, {});
    });

    const res = await getTool(
      'sandbox_to_vfs',
      makeDeps(fetchImpl),
      sandbox.factory,
    ).handler(
      {
        sandboxPath: '/workspace/output/a.txt',
        vfsPath: '/a.txt',
        overwrite: true,
      },
      makeCtx(),
    );

    expect(calls.some((c) => c.method === 'PUT')).toBe(true);
    const out = JSON.parse(res as string);
    expect(out.ok).toBe(true);
    expect(out.cid).toBe('f9');
  });

  it('deletes the sandbox source when deleteSource is set', async () => {
    const sandbox = makeSandboxFactory({
      run: async (input) => {
        const code = (input as { code: string }).code;
        if (code.includes('rm -f')) {
          return envelope({ success: true, exitCode: 0, output: '' });
        }
        return envelope({
          success: true,
          exitCode: 0,
          output: Buffer.from('bye').toString('base64'),
        });
      },
    });
    const { fetchImpl } = makeFetch(() =>
      jsonRes(200, { id: 'f2', path: '/gone.txt' }),
    );

    const res = await getTool(
      'sandbox_to_vfs',
      makeDeps(fetchImpl),
      sandbox.factory,
    ).handler(
      {
        sandboxPath: '/workspace/output/gone.txt',
        vfsPath: '/gone.txt',
        deleteSource: true,
      },
      makeCtx(),
    );

    expect(sandbox.runInvoke).toHaveBeenCalledTimes(2);
    const rmCode = sandbox.runInvoke.mock.calls[1]?.[0] as { code: string };
    expect(rmCode.code).toContain('rm -f');
    const out = JSON.parse(res as string);
    expect(out.deletedSource).toBe(true);
  });

  it('rejects a sandbox path with an unquotable character before doing any work', async () => {
    const sandbox = makeSandboxFactory();
    const { fetchImpl, calls } = makeFetch(() => jsonRes(200, {}));

    const res = await getTool(
      'sandbox_to_vfs',
      makeDeps(fetchImpl),
      sandbox.factory,
    ).handler(
      { sandboxPath: "/workspace/output/a'b.txt", vfsPath: '/a.txt' },
      makeCtx(),
    );

    expect(res).toContain("characters I can't safely handle");
    expect(sandbox.factoryCalls()).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// vfs_to_sandbox
// ---------------------------------------------------------------------------

describe('vfs_to_sandbox', () => {
  function vfsFileRoutes(
    stat: { id: string; path: string; mimeType: string; size?: number },
    content: Uint8Array,
    contentMime: string,
    onTrash?: () => Response,
  ): RouteHandler {
    return (url, init) => {
      if (url.includes('/glob')) {
        return jsonRes(200, { files: [stat] });
      }
      if (url.includes('/content')) {
        return bytesRes(200, content, contentMime);
      }
      if (url.includes('/batch/delete') && init.method === 'POST') {
        return onTrash
          ? onTrash()
          : jsonRes(200, { results: [{ id: stat.id, ok: true }] });
      }
      return jsonRes(404, {});
    };
  }

  it('writes a text file to the sandbox as utf8', async () => {
    const sandbox = makeSandboxFactory();
    const { fetchImpl } = makeFetch(
      vfsFileRoutes(
        { id: 'v1', path: '/notes.txt', mimeType: 'text/plain', size: 5 },
        new Uint8Array(Buffer.from('hello')),
        'text/plain',
      ),
    );

    const res = await getTool(
      'vfs_to_sandbox',
      makeDeps(fetchImpl),
      sandbox.factory,
    ).handler(
      { vfsPath: '/notes.txt', sandboxPath: '/workspace/data/input/notes.txt' },
      makeCtx(),
    );

    expect(sandbox.writeInvoke).toHaveBeenCalledWith({
      path: '/workspace/data/input/notes.txt',
      content: 'hello',
      encoding: 'utf8',
    });
    const out = JSON.parse(res as string);
    expect(out).toMatchObject({
      ok: true,
      sandboxPath: '/workspace/data/input/notes.txt',
      bytes: 5,
      movedFromVfs: '/notes.txt',
      deletedSource: false,
    });
    expect(sandbox.closeSpy).toHaveBeenCalledTimes(1);
  });

  it('writes a binary file to the sandbox as base64', async () => {
    const bytes = new Uint8Array([1, 2, 3, 250]);
    const sandbox = makeSandboxFactory();
    const { fetchImpl } = makeFetch(
      vfsFileRoutes(
        { id: 'v2', path: '/logo.png', mimeType: 'image/png', size: 4 },
        bytes,
        'image/png',
      ),
    );

    await getTool(
      'vfs_to_sandbox',
      makeDeps(fetchImpl),
      sandbox.factory,
    ).handler(
      { vfsPath: '/logo.png', sandboxPath: '/workspace/data/input/logo.png' },
      makeCtx(),
    );

    expect(sandbox.writeInvoke).toHaveBeenCalledWith({
      path: '/workspace/data/input/logo.png',
      content: Buffer.from(bytes).toString('base64'),
      encoding: 'base64',
    });
  });

  it('rejects a sandbox path outside /workspace/data/ before any work', async () => {
    const sandbox = makeSandboxFactory();
    const { fetchImpl, calls } = makeFetch(() => jsonRes(200, {}));

    const res = await getTool(
      'vfs_to_sandbox',
      makeDeps(fetchImpl),
      sandbox.factory,
    ).handler(
      { vfsPath: '/notes.txt', sandboxPath: '/tmp/notes.txt' },
      makeCtx(),
    );

    expect(res).toContain('must be under /workspace/data/');
    expect(sandbox.factoryCalls()).toBe(0);
    expect(sandbox.writeInvoke).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('returns a not-found message when the VFS file is missing', async () => {
    const sandbox = makeSandboxFactory();
    const { fetchImpl } = makeFetch((url) =>
      url.includes('/glob') ? jsonRes(200, { files: [] }) : jsonRes(404, {}),
    );

    const res = await getTool(
      'vfs_to_sandbox',
      makeDeps(fetchImpl),
      sandbox.factory,
    ).handler(
      { vfsPath: '/nope.txt', sandboxPath: '/workspace/data/input/nope.txt' },
      makeCtx(),
    );

    expect(res).toBe('No such file at `/nope.txt`.');
    expect(sandbox.writeInvoke).not.toHaveBeenCalled();
    expect(sandbox.closeSpy).toHaveBeenCalledTimes(1);
  });

  it('trashes the VFS source when deleteSource is set', async () => {
    const sandbox = makeSandboxFactory();
    const { fetchImpl, calls } = makeFetch(
      vfsFileRoutes(
        { id: 'v3', path: '/move.csv', mimeType: 'text/csv', size: 3 },
        new Uint8Array(Buffer.from('a,b')),
        'text/csv',
      ),
    );

    const res = await getTool(
      'vfs_to_sandbox',
      makeDeps(fetchImpl),
      sandbox.factory,
    ).handler(
      {
        vfsPath: '/move.csv',
        sandboxPath: '/workspace/data/input/move.csv',
        deleteSource: true,
      },
      makeCtx(),
    );

    expect(calls.some((c) => c.url.includes('/batch/delete'))).toBe(true);
    const out = JSON.parse(res as string);
    expect(out.deletedSource).toBe(true);
    expect(out.note).toContain('trash');
  });

  it('surfaces a sandbox write failure without throwing', async () => {
    const sandbox = makeSandboxFactory({
      writeFile: async () => envelope({ success: false, error: 'disk full' }),
    });
    const { fetchImpl } = makeFetch(
      vfsFileRoutes(
        { id: 'v4', path: '/x.txt', mimeType: 'text/plain', size: 2 },
        new Uint8Array(Buffer.from('hi')),
        'text/plain',
      ),
    );

    const res = await getTool(
      'vfs_to_sandbox',
      makeDeps(fetchImpl),
      sandbox.factory,
    ).handler(
      { vfsPath: '/x.txt', sandboxPath: '/workspace/data/input/x.txt' },
      makeCtx(),
    );

    expect(res).toContain("Couldn't write");
    expect(res).toContain('disk full');
  });
});

// ---------------------------------------------------------------------------
// Degradation
// ---------------------------------------------------------------------------

describe('sandbox bridge degradation', () => {
  it('degrades when the sandbox is not authorized (no Authorization header)', async () => {
    const sandbox = makeSandboxFactory();
    const { fetchImpl, calls } = makeFetch(() => jsonRes(200, {}));
    const ctx = makeCtx(ucanStub({ resolveServiceDid: async () => null }));

    const res = await getTool(
      'sandbox_to_vfs',
      makeDeps(fetchImpl),
      sandbox.factory,
    ).handler(
      { sandboxPath: '/workspace/output/a.txt', vfsPath: '/a.txt' },
      ctx,
    );

    expect(res).toContain('authorized the sandbox');
    expect(sandbox.factoryCalls()).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('degrades when the sandbox is missing the required file tools', async () => {
    const sandbox = makeSandboxFactory({ tools: ['sandbox_run'] });
    const { fetchImpl } = makeFetch(() => jsonRes(200, {}));

    const res = await getTool(
      'vfs_to_sandbox',
      makeDeps(fetchImpl),
      sandbox.factory,
    ).handler(
      { vfsPath: '/x.txt', sandboxPath: '/workspace/data/input/x.txt' },
      makeCtx(),
    );

    expect(res).toContain('not exposing the file tools');
    expect(sandbox.closeSpy).toHaveBeenCalledTimes(1);
  });
});

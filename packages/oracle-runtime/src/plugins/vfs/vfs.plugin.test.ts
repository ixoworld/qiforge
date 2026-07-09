import { AIMessage } from '@langchain/core/messages';
import { fakeModel } from 'langchain';
import { describe, expect, it, vi } from 'vitest';
import { validateManifest } from '../../manifest/validator.js';
import { makeRuntimeContext } from '../../registries/test-fixtures.js';
import type { RuntimeContext } from '../../plugin-api/types.js';
import { createVfsTools, type CreateVfsToolsDeps } from './vfs-tools.js';
import { NO_ACCESS_MESSAGE } from './vfs-errors.js';
import { VfsPlugin, type VfsConfig } from './vfs.plugin.js';

const VFS_URL = 'https://vfs.test';
const STORE_URL = 'https://ucan.test';

function cfg(overrides: Partial<VfsConfig> = {}): VfsConfig {
  return {
    VFS_BASE_URL: VFS_URL,
    UCAN_STORE_URL: STORE_URL,
    VFS_MAX_READ_LINES: 2000,
    VFS_REQUEST_TIMEOUT_MS: 20000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake transport + runtime context
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
  body?: string;
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
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw && !Array.isArray(raw) && !(raw instanceof Headers)) {
      for (const [k, v] of Object.entries(raw)) headers[k] = String(v);
    }
    calls.push({ url, method, body, headers });
    return handler(url, init ?? {});
  };
  return { fetchImpl, calls };
}

interface UcanOverrides {
  getServiceDelegation?: RuntimeContext['ucan']['getServiceDelegation'];
  createInvocationFromDelegation?: RuntimeContext['ucan']['createInvocationFromDelegation'];
  hasSigningKey?: () => boolean;
}

function ucanStub(overrides: UcanOverrides = {}): RuntimeContext['ucan'] {
  return {
    requireCapability: () => undefined,
    hasCapability: () => true,
    mintInvocation: async () => 'x',
    resolveServiceDid: async () => 'did:web:vfs.test',
    hasSigningKey: overrides.hasSigningKey ?? (() => true),
    createInvocationFromDelegation:
      overrides.createInvocationFromDelegation ??
      vi.fn(async () => ({ invocation: 'inv-bearer' })),
    mintSelfSignedInvocation: async () => ({ invocation: 'x' }),
    getServiceDelegation:
      overrides.getServiceDelegation ??
      vi.fn(async () => ({ token: 'del-token', with: 'ixo:filesystem' })),
  };
}

function makeCtx(
  opts: {
    ucan?: RuntimeContext['ucan'];
    model?: ReturnType<typeof fakeModel>;
  } = {},
): { ctx: RuntimeContext; llmGet: ReturnType<typeof vi.fn> } {
  const ucan = opts.ucan ?? ucanStub();
  const llmGet = vi.fn(
    () => opts.model ?? fakeModel().respond(new AIMessage('a red circle')),
  );
  const ctx = makeRuntimeContext({
    config: cfg(),
    user: {
      did: 'did:ixo:alice',
      matrixUserId: '@alice:ixo.world',
      ucanDelegation: { raw: 'x' },
    },
    ucan,
    llm: { get: llmGet },
  });
  return { ctx, llmGet };
}

function toolDeps(fetchImpl: typeof fetch): CreateVfsToolsDeps {
  return { cfg: cfg(), fetchImpl, retryDelayMs: 0 };
}

function getTool(name: string, deps: CreateVfsToolsDeps) {
  const t = createVfsTools(deps).find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

// ---------------------------------------------------------------------------
// Plugin identity / config / manifest / gates
// ---------------------------------------------------------------------------

describe('VfsPlugin — identity, config, manifest', () => {
  it('exposes the expected shape', () => {
    const p = new VfsPlugin();
    expect(p.name).toBe('vfs');
    expect(p.version).toBe('1.0.0');
    expect(p.manifest.title).toBe('Files');
    expect(p.manifest.visibility).toBe('always');
    expect(p.manifest.category).toBe('data');
    // Always-on: the worker URLs come from NETWORK, so there is no env var to
    // detect and no autoDetect gate. A fork opts out via features.
    expect(p.autoDetect).toBeUndefined();
    expect(p.autoDetectHint).toBeUndefined();
  });

  it('applies numeric tuning defaults and coerces string env values', () => {
    const p = new VfsPlugin();
    // configSchema owns only optional tuning — the worker URLs are derived from
    // NETWORK, not validated here — so an empty env parses with the defaults.
    const parsed = p.configSchema.safeParse({});
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.VFS_MAX_READ_LINES).toBe(2000);
    expect(parsed.success && parsed.data.VFS_REQUEST_TIMEOUT_MS).toBe(20000);

    const coerced = p.configSchema.safeParse({ VFS_MAX_READ_LINES: '500' });
    expect(coerced.success && coerced.data.VFS_MAX_READ_LINES).toBe(500);
  });

  it('manifest passes validateManifest', () => {
    const p = new VfsPlugin();
    const result = validateManifest(p.manifest, p.name);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe('VfsPlugin.getRequestTools — gating', () => {
  it('contributes all ten tools when config + signing key are present', () => {
    const p = new VfsPlugin();
    const { ctx } = makeCtx();
    const tools = p.getRequestTools(ctx);
    expect(tools.map((t) => t.name)).toEqual([
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
    ]);
  });

  it('derives worker URLs from NETWORK — contributes tools with no URL env', () => {
    const p = new VfsPlugin();
    // Only NETWORK in config; no VFS_BASE_URL / UCAN_STORE_URL anywhere.
    const ctx = makeRuntimeContext({ config: { NETWORK: 'testnet' } });
    const names = p.getRequestTools(ctx).map((t) => t.name);
    expect(names).toContain('vfs_read');
    expect(names).toHaveLength(10);
  });

  it('contributes nothing when the oracle has no signing key', () => {
    const p = new VfsPlugin();
    const ctx = makeRuntimeContext({
      config: cfg(),
      ucan: ucanStub({ hasSigningKey: () => false }),
    });
    expect(p.getRequestTools(ctx)).toEqual([]);
  });

  it('appends the two sandbox bridge tools when SANDBOX_MCP_URL is present', () => {
    const p = new VfsPlugin();
    const ctx = makeRuntimeContext({
      config: { ...cfg(), SANDBOX_MCP_URL: 'https://sandbox.test' },
      user: {
        did: 'did:ixo:alice',
        matrixUserId: '@alice:ixo.world',
        ucanDelegation: { raw: 'x' },
      },
      ucan: ucanStub(),
    });
    const names = p.getRequestTools(ctx).map((t) => t.name);
    expect(names).toContain('sandbox_to_vfs');
    expect(names).toContain('vfs_to_sandbox');
    expect(names).toHaveLength(12);
  });

  it('omits the sandbox bridge tools when SANDBOX_MCP_URL is absent', () => {
    const p = new VfsPlugin();
    const { ctx } = makeCtx();
    const names = p.getRequestTools(ctx).map((t) => t.name);
    expect(names).not.toContain('sandbox_to_vfs');
    expect(names).not.toContain('vfs_to_sandbox');
    expect(names).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// Tool happy paths (URL / method / ability assertions)
// ---------------------------------------------------------------------------

describe('VFS tools — happy paths', () => {
  it('vfs_search hits /search with fs/read and formats hits', async () => {
    const getServiceDelegation = vi.fn(async () => ({
      token: 'del-token',
      with: 'ixo:filesystem',
    }));
    const createInvocationFromDelegation = vi.fn(async () => ({
      invocation: 'inv-bearer',
    }));
    const { ctx } = makeCtx({
      ucan: ucanStub({ getServiceDelegation, createInvocationFromDelegation }),
    });
    // Real `/search` response: hits under `hits`, file id as `fileId`, snippet
    // as `preview`.
    const { fetchImpl, calls } = makeFetch(() =>
      jsonRes(200, {
        hits: [
          {
            fileId: 'f9',
            path: '/notes/pricing.md',
            lineStart: 10,
            lineEnd: 14,
            preview: 'pricing details',
          },
        ],
        semantic: true,
      }),
    );

    const res = await getTool('vfs_search', toolDeps(fetchImpl)).handler(
      { q: 'pricing', path: '/' },
      ctx,
    );

    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toContain('/search?q=pricing');
    expect(calls[0]?.headers['x-auth-type']).toBe('ucan');
    expect(calls[0]?.headers.authorization).toBe('Bearer inv-bearer');
    expect(getServiceDelegation.mock.calls[0]?.[1].requiredAbility).toBe(
      'fs/read',
    );
    expect(createInvocationFromDelegation.mock.calls[0]?.[2].can).toBe(
      'fs/read',
    );
    expect(res).toContain('/notes/pricing.md');
    expect(res).toContain('lines 10-14');
  });

  it('vfs_grep hits /grep with fs/read', async () => {
    const getServiceDelegation = vi.fn(async () => ({
      token: 'del-token',
      with: 'ixo:filesystem',
    }));
    const { ctx } = makeCtx({ ucan: ucanStub({ getServiceDelegation }) });
    // Real `/grep` response: matches under `matches` (FileMetadata + snippet).
    const { fetchImpl, calls } = makeFetch(() =>
      jsonRes(200, {
        matches: [{ id: 'a', path: '/a.md', snippet: '«TODO» item' }],
      }),
    );

    const res = await getTool('vfs_grep', toolDeps(fetchImpl)).handler(
      { q: 'TODO', path: '/' },
      ctx,
    );

    expect(calls[0]?.url).toContain('/grep?q=TODO');
    expect(getServiceDelegation.mock.calls[0]?.[1].requiredAbility).toBe(
      'fs/read',
    );
    expect(res).toContain('/a.md');
  });

  it('vfs_glob hits /glob with fs/list', async () => {
    const getServiceDelegation = vi.fn(async () => ({
      token: 'del-token',
      with: 'ixo:filesystem',
    }));
    const { ctx } = makeCtx({ ucan: ucanStub({ getServiceDelegation }) });
    // Real `/glob` response: files under `files` (full FileMetadata with id).
    const { fetchImpl, calls } = makeFetch(() =>
      jsonRes(200, {
        files: [
          { id: 'a', path: '/a.md' },
          { id: 'b', path: '/b.md' },
        ],
      }),
    );

    const res = await getTool('vfs_glob', toolDeps(fetchImpl)).handler(
      { pattern: '/*.md' },
      ctx,
    );

    expect(calls[0]?.url).toContain('/glob?pattern=');
    expect(getServiceDelegation.mock.calls[0]?.[1].requiredAbility).toBe(
      'fs/list',
    );
    expect(res).toContain('/a.md');
    expect(res).toContain('/b.md');
  });

  it('vfs_list hits /tree with fs/list and marks folders', async () => {
    const { ctx } = makeCtx();
    // Real `/tree` response: directory listing under `nodes`.
    const { fetchImpl, calls } = makeFetch(() =>
      jsonRes(200, {
        nodes: [
          { path: '/notes', name: 'notes', type: 'folder' },
          { path: '/todo.md', name: 'todo.md', type: 'file' },
        ],
      }),
    );

    const res = await getTool('vfs_list', toolDeps(fetchImpl)).handler(
      { path: '/' },
      ctx,
    );

    expect(calls[0]?.url).toContain('/tree?path=');
    expect(res).toContain('/notes/');
    expect(res).toContain('/todo.md');
  });

  it('vfs_read on a text file returns numbered lines', async () => {
    const { ctx } = makeCtx();
    const { fetchImpl, calls } = makeFetch((url) => {
      if (url.includes('/glob')) {
        return jsonRes(200, {
          files: [
            { id: 'f1', path: '/todo.md', mimeType: 'text/markdown', size: 20 },
          ],
        });
      }
      if (url.includes('/read')) {
        // Real `/read` response: 1-based `offset`, `count`, and display-ready
        // numbered `text`.
        return jsonRes(200, {
          offset: 1,
          count: 2,
          hasMore: false,
          totalLines: 2,
          text: '     1→line one\n     2→line two',
        });
      }
      return jsonRes(404, {});
    });

    const res = await getTool('vfs_read', toolDeps(fetchImpl)).handler(
      { path: '/todo.md' },
      ctx,
    );

    // The server sends 1-based reads; the client must never send offset=0.
    expect(calls.some((c) => c.url.includes('/files/f1/read?offset=1'))).toBe(
      true,
    );
    expect(res).toContain('1→line one');
    expect(res).toContain('2→line two');
  });

  it('vfs_read pages long files with a continuation footer', async () => {
    const { ctx } = makeCtx();
    const { fetchImpl } = makeFetch((url) => {
      if (url.includes('/glob')) {
        return jsonRes(200, {
          files: [{ id: 'f1', path: '/big.md', mimeType: 'text/markdown' }],
        });
      }
      return jsonRes(200, {
        offset: 1,
        count: 2,
        hasMore: true,
        totalLines: 100,
        text: '     1→a\n     2→b',
      });
    });

    const res = await getTool('vfs_read', toolDeps(fetchImpl)).handler(
      { path: '/big.md' },
      ctx,
    );
    // Next page starts at offset + count = 1 + 2 = 3.
    expect(res).toContain('offset=3');
    expect(res).toContain('100 total');
  });

  it('vfs_write creates a file with fs/write and posts the body', async () => {
    const getServiceDelegation = vi.fn(async () => ({
      token: 'del-token',
      with: 'ixo:filesystem',
    }));
    const { ctx } = makeCtx({ ucan: ucanStub({ getServiceDelegation }) });
    const { fetchImpl, calls } = makeFetch(() =>
      jsonRes(200, { id: 'f2', path: '/notes/x.md' }),
    );

    const res = await getTool('vfs_write', toolDeps(fetchImpl)).handler(
      { path: '/notes/x.md', content: 'hello world' },
      ctx,
    );

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toContain('/files?path=');
    expect(calls[0]?.body).toBe('hello world');
    expect(calls[0]?.headers['content-type']).toBe('text/markdown');
    expect(getServiceDelegation.mock.calls[0]?.[1].requiredAbility).toBe(
      'fs/write',
    );
    expect(res).toContain('Created');
    expect(res).toContain('/notes/x.md');
  });

  it('vfs_edit resolves the id then PATCHes with fs/write', async () => {
    const { ctx } = makeCtx();
    const { fetchImpl, calls } = makeFetch((url) => {
      if (url.includes('/glob')) {
        return jsonRes(200, {
          files: [{ id: 'f1', path: '/todo.md', mimeType: 'text/markdown' }],
        });
      }
      return jsonRes(200, { replacements: 1 });
    });

    const res = await getTool('vfs_edit', toolDeps(fetchImpl)).handler(
      { path: '/todo.md', oldString: 'Draft', newString: 'Final' },
      ctx,
    );

    expect(
      calls.some((c) => c.method === 'PATCH' && c.url.includes('/edit')),
    ).toBe(true);
    expect(res).toContain('Edited');
  });

  it('vfs_move posts to /batch/move with fs/write', async () => {
    const getServiceDelegation = vi.fn(async () => ({
      token: 'del-token',
      with: 'ixo:filesystem',
    }));
    const { ctx } = makeCtx({ ucan: ucanStub({ getServiceDelegation }) });
    // Move resolves the source path to an id via /glob, then posts /batch/move
    // with { id, destinationPath } (the worker addresses moves by id).
    const { fetchImpl, calls } = makeFetch((url) => {
      if (url.includes('/glob')) {
        return jsonRes(200, { files: [{ id: 'a', path: '/a' }] });
      }
      return jsonRes(200, {
        results: [{ id: 'a', ok: true, status: 200, path: '/b' }],
        succeeded: 1,
        failed: 0,
      });
    });

    const res = await getTool('vfs_move', toolDeps(fetchImpl)).handler(
      { from: '/a', to: '/b' },
      ctx,
    );

    const moveCall = calls.find((c) => c.url.includes('/batch/move'));
    expect(moveCall).toBeDefined();
    expect(moveCall?.body).toContain('destinationPath');
    // The batch move itself is authorized with fs/write (the prior /glob
    // resolution mints fs/list).
    expect(
      getServiceDelegation.mock.calls.some(
        (c) => c[1].requiredAbility === 'fs/write',
      ),
    ).toBe(true);
    expect(res).toContain('Moved');
  });

  it('vfs_delete resolves ids, trashes with fs/delete, and reports per-item results', async () => {
    const getServiceDelegation = vi.fn(async () => ({
      token: 'del-token',
      with: 'ixo:filesystem',
    }));
    const { ctx } = makeCtx({ ucan: ucanStub({ getServiceDelegation }) });
    const { fetchImpl, calls } = makeFetch((url) => {
      if (url.includes('/glob')) {
        const id = url.includes('a.md') ? 'a' : 'b';
        return jsonRes(200, { files: [{ id, path: `/${id}.md` }] });
      }
      return jsonRes(200, {
        results: [
          { id: 'a', ok: true },
          { id: 'b', ok: false, status: 404, error: 'not found' },
        ],
      });
    });

    const res = await getTool('vfs_delete', toolDeps(fetchImpl)).handler(
      { paths: ['/a.md', '/b.md'] },
      ctx,
    );

    expect(calls.some((c) => c.url.includes('/batch/delete'))).toBe(true);
    const deleteAbilities = getServiceDelegation.mock.calls.map(
      (c) => c[1].requiredAbility,
    );
    expect(deleteAbilities).toContain('fs/delete');
    expect(res).toContain('1 of 2');
    expect(res).toContain('not found');
  });

  it('vfs_share publishes a file and returns the link', async () => {
    const { ctx } = makeCtx();
    const { fetchImpl, calls } = makeFetch((url) => {
      if (url.includes('/glob')) {
        return jsonRes(200, { files: [{ id: 'f3', path: '/resume.pdf' }] });
      }
      return jsonRes(200, {
        public: true,
        publicUrl: 'https://vfs.test/p/abc',
      });
    });

    const res = await getTool('vfs_share', toolDeps(fetchImpl)).handler(
      { path: '/resume.pdf', public: true },
      ctx,
    );

    expect(calls.some((c) => c.url.includes('/files/f3/public'))).toBe(true);
    expect(res).toContain('now public');
    expect(res).toContain('https://vfs.test/p/abc');
  });
});

// ---------------------------------------------------------------------------
// Content delivery — images route through the vision model
// ---------------------------------------------------------------------------

describe('VFS content delivery', () => {
  it('vfs_read on an image routes bytes through the vision model', async () => {
    const model = fakeModel().respond(new AIMessage('a red circle'));
    const { ctx, llmGet } = makeCtx({ model });
    const { fetchImpl, calls } = makeFetch((url) => {
      if (url.includes('/glob')) {
        return jsonRes(200, {
          files: [
            { id: 'img1', path: '/pic.png', mimeType: 'image/png', size: 3 },
          ],
        });
      }
      if (url.includes('/content')) {
        return bytesRes(200, new Uint8Array([1, 2, 3]), 'image/png');
      }
      return jsonRes(404, {});
    });

    const res = await getTool('vfs_read', toolDeps(fetchImpl)).handler(
      { path: '/pic.png' },
      ctx,
    );

    expect(calls.some((c) => c.url.includes('/files/img1/content'))).toBe(true);
    expect(calls.some((c) => c.url.includes('/read'))).toBe(false);
    expect(llmGet).toHaveBeenCalledWith('vision');
    expect(res).toBe('a red circle');
  });

  it('falls back to the binary path when a line-read returns 415', async () => {
    const model = fakeModel().respond(new AIMessage('transcribed pdf'));
    const { ctx } = makeCtx({ model });
    const { fetchImpl } = makeFetch((url) => {
      if (url.includes('/glob')) {
        // unknown mime → the tool attempts a line read first
        return jsonRes(200, {
          files: [{ id: 'd1', path: '/doc.pdf', mimeType: '', size: 4 }],
        });
      }
      if (url.includes('/read')) return jsonRes(415, { error: 'not text' });
      if (url.includes('/content')) {
        return bytesRes(200, new Uint8Array([9, 9, 9, 9]), 'application/pdf');
      }
      return jsonRes(404, {});
    });

    const res = await getTool('vfs_read', toolDeps(fetchImpl)).handler(
      { path: '/doc.pdf' },
      ctx,
    );
    expect(res).toBe('transcribed pdf');
  });
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

describe('VFS error mapping', () => {
  async function listWith(status: number, body: unknown): Promise<string> {
    const { ctx } = makeCtx();
    const { fetchImpl } = makeFetch(() => jsonRes(status, body));
    return getTool('vfs_list', toolDeps(fetchImpl)).handler({ path: '/' }, ctx);
  }

  it('401 → authentication failure message', async () => {
    expect(await listWith(401, { error: 'unauthorized' })).toBe(
      "Couldn't authenticate to your filesystem right now.",
    );
  });

  it('403 → out-of-scope message', async () => {
    const res = await listWith(403, { error: 'forbidden' });
    expect(res).toContain('outside what you shared');
  });

  it('404 → no-such-file message', async () => {
    const res = await listWith(404, { error: 'not found' });
    expect(res).toContain('No such file');
  });

  it('429 → busy message', async () => {
    const res = await listWith(429, { error: 'rate limited' });
    expect(res).toContain('busy');
  });

  it('plain-text error body is surfaced', async () => {
    const { ctx } = makeCtx();
    const { fetchImpl } = makeFetch(
      () => new Response('nope', { status: 400 }),
    );
    const res = await getTool('vfs_list', toolDeps(fetchImpl)).handler(
      { path: '/' },
      ctx,
    );
    expect(res).toContain('nope');
  });

  it('409 already-exists (no overwrite) asks before overwriting', async () => {
    const { ctx } = makeCtx();
    const { fetchImpl } = makeFetch(() =>
      jsonRes(409, { error: 'File already exists' }),
    );
    const res = await getTool('vfs_write', toolDeps(fetchImpl)).handler(
      { path: '/x.md', content: 'hi' },
      ctx,
    );
    expect(res).toContain('already exists at `/x.md`');
    expect(res).toContain('before overwriting');
  });

  it('409 already-exists with overwrite replaces the file', async () => {
    const { ctx } = makeCtx();
    const { fetchImpl, calls } = makeFetch((url, init) => {
      if (url.includes('/files?path=') && init.method === 'POST') {
        return jsonRes(409, { error: 'File already exists' });
      }
      if (url.includes('/glob')) {
        return jsonRes(200, {
          files: [{ id: 'f9', path: '/x.md', mimeType: 'text/markdown' }],
        });
      }
      if (init.method === 'PUT')
        return jsonRes(200, { id: 'f9', path: '/x.md' });
      return jsonRes(404, {});
    });

    const res = await getTool('vfs_write', toolDeps(fetchImpl)).handler(
      { path: '/x.md', content: 'hi', overwrite: true },
      ctx,
    );
    expect(calls.some((c) => c.method === 'PUT')).toBe(true);
    expect(res).toContain('Replaced');
  });

  it('409 oldString-not-found relays edit guidance', async () => {
    const { ctx } = makeCtx();
    const { fetchImpl } = makeFetch((url) => {
      if (url.includes('/glob')) {
        return jsonRes(200, {
          files: [{ id: 'f1', path: '/todo.md', mimeType: 'text/markdown' }],
        });
      }
      return jsonRes(409, { error: 'oldString not found in file' });
    });
    const res = await getTool('vfs_edit', toolDeps(fetchImpl)).handler(
      { path: '/todo.md', oldString: 'X', newString: 'Y' },
      ctx,
    );
    expect(res).toContain('replaceAll');
  });

  it('409 destination-occupied relays a move conflict', async () => {
    const { ctx } = makeCtx();
    const { fetchImpl } = makeFetch(() =>
      jsonRes(409, { error: 'Destination occupied' }),
    );
    const res = await getTool('vfs_move', toolDeps(fetchImpl)).handler(
      { from: '/a', to: '/b' },
      ctx,
    );
    expect(res).toContain('occupied');
  });

  it('409 version-limit surfaces the 50-version cap', async () => {
    const { ctx } = makeCtx();
    const { fetchImpl } = makeFetch((url) => {
      if (url.includes('/glob')) {
        return jsonRes(200, {
          files: [{ id: 'f1', path: '/todo.md', mimeType: 'text/markdown' }],
        });
      }
      return jsonRes(409, {
        error: 'Version limit reached: file has 50 versions',
      });
    });
    const res = await getTool('vfs_edit', toolDeps(fetchImpl)).handler(
      { path: '/todo.md', oldString: 'X', newString: 'Y' },
      ctx,
    );
    expect(res).toContain('50-version limit');
  });
});

// ---------------------------------------------------------------------------
// Degradation + concurrency
// ---------------------------------------------------------------------------

describe('VFS degradation & retry', () => {
  it('returns the no-access message and never hits the network without a delegation', async () => {
    const { ctx } = makeCtx({
      ucan: ucanStub({
        getServiceDelegation: vi.fn(async () => ({
          error: 'no-delegation' as const,
        })),
      }),
    });
    const { fetchImpl, calls } = makeFetch(() => jsonRes(200, {}));
    const res = await getTool('vfs_list', toolDeps(fetchImpl)).handler(
      { path: '/' },
      ctx,
    );
    expect(res).toBe(NO_ACCESS_MESSAGE);
    expect(calls).toHaveLength(0);
  });

  it('store-error degrades to a generic access message', async () => {
    const { ctx } = makeCtx({
      ucan: ucanStub({
        getServiceDelegation: vi.fn(async () => ({
          error: 'store-error' as const,
          detail: 'store 500',
        })),
      }),
    });
    const { fetchImpl } = makeFetch(() => jsonRes(200, {}));
    const res = await getTool('vfs_list', toolDeps(fetchImpl)).handler(
      { path: '/' },
      ctx,
    );
    expect(res).toBe("Couldn't get filesystem access right now.");
  });

  it('retries an edit once on 409 modified-concurrently, then succeeds', async () => {
    const { ctx } = makeCtx();
    let editCalls = 0;
    const { fetchImpl } = makeFetch((url) => {
      if (url.includes('/glob')) {
        return jsonRes(200, {
          files: [{ id: 'f1', path: '/todo.md', mimeType: 'text/markdown' }],
        });
      }
      editCalls += 1;
      if (editCalls === 1) {
        return jsonRes(409, { error: 'File was modified concurrently' });
      }
      return jsonRes(200, { replacements: 1 });
    });

    const res = await getTool('vfs_edit', toolDeps(fetchImpl)).handler(
      { path: '/todo.md', oldString: 'Draft', newString: 'Final' },
      ctx,
    );
    expect(editCalls).toBe(2);
    expect(res).toContain('Edited');
  });

  it('gives up after a second modified-concurrently conflict', async () => {
    const { ctx } = makeCtx();
    let editCalls = 0;
    const { fetchImpl } = makeFetch((url) => {
      if (url.includes('/glob')) {
        return jsonRes(200, {
          files: [{ id: 'f1', path: '/todo.md', mimeType: 'text/markdown' }],
        });
      }
      editCalls += 1;
      return jsonRes(409, { error: 'File was modified concurrently' });
    });

    const res = await getTool('vfs_edit', toolDeps(fetchImpl)).handler(
      { path: '/todo.md', oldString: 'Draft', newString: 'Final' },
      ctx,
    );
    expect(editCalls).toBe(2);
    expect(res).toContain('changed by someone else');
  });

  it('rejects a non-absolute path before any network call', async () => {
    const { ctx } = makeCtx();
    const { fetchImpl, calls } = makeFetch(() => jsonRes(200, {}));
    const res = await getTool('vfs_read', toolDeps(fetchImpl)).handler(
      { path: 'todo.md' },
      ctx,
    );
    expect(res).toContain('absolute');
    expect(calls).toHaveLength(0);
  });
});

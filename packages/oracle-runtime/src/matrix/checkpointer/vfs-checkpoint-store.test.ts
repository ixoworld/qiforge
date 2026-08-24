import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { VfsDelegationMinter } from '../../plugins/vfs/vfs-auth.js';
import { VfsAuthError } from '../../plugins/vfs/vfs-errors.js';
import { uploadTimeoutMs, VfsCheckpointStore } from './vfs-checkpoint-store.js';

const URLS = { vfs: 'https://vfs.test', store: 'https://store.test' };
const ENTITY = 'did:ixo:entity:abc';

function minter(delegation: 'ok' | 'none' = 'ok'): VfsDelegationMinter {
  return {
    getServiceDelegation: vi.fn(async () =>
      delegation === 'ok'
        ? { token: 'CAR', with: `ixo:filesystem/oracle-data/${ENTITY}` }
        : { error: 'no-delegation' as const },
    ),
    createInvocationFromDelegation: vi.fn(async () => ({ invocation: 'INV' })),
  };
}

function store(
  fetchImpl: typeof fetch,
  opts: { delegation?: 'ok' | 'none'; knownId?: string } = {},
) {
  return new VfsCheckpointStore({
    minter: minter(opts.delegation),
    urls: URLS,
    oracleEntityDid: ENTITY,
    knownFileId: () => opts.knownId,
    timeoutMs: 1000,
    fetchImpl,
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe('VfsCheckpointStore', () => {
  it('builds the backup path under the delegated subtree', () => {
    expect(VfsCheckpointStore.backupPath(ENTITY, 'k1')).toBe(
      `oracle-data/${ENTITY}/k1.db.gz`,
    );
  });

  it('is available only when a delegation exists', async () => {
    const f = vi.fn(async () => json({}));
    expect(await store(f, { delegation: 'ok' }).available('did:ixo:u')).toBe(
      true,
    );
    expect(await store(f, { delegation: 'none' }).available('did:ixo:u')).toBe(
      false,
    );
  });

  it('creates on first upload and returns the file id + cid', async () => {
    const f = vi.fn(async () =>
      json({ id: 'f1', cid: 'bafy', path: 'p' }, 201),
    );
    const result = await store(f).upload({
      userDid: 'did:ixo:u',
      storageKey: 'k1',
      openStream: () => Readable.from([Buffer.from('gz')]),
      sizeBytes: 2,
    });
    expect(result).toEqual({ pointer: 'f1', cid: 'bafy' });
    expect(String(f.mock.calls[0]?.[0])).toContain(
      '/files?path=oracle-data%2F',
    );
  });

  it('replaces by known id when the path already exists', async () => {
    const f = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/files?path='))
        return new Response(
          JSON.stringify({ error: 'already exists', status: 409 }),
          { status: 409 },
        );
      if (url.endsWith('/files/f1')) return json({ id: 'f1', cid: 'bafy2' });
      throw new Error(`unexpected ${url}`);
    });
    const result = await store(f, { knownId: 'f1' }).upload({
      userDid: 'did:ixo:u',
      storageKey: 'k1',
      openStream: () => Readable.from([Buffer.from('gz')]),
      sizeBytes: 2,
    });
    expect(result).toEqual({ pointer: 'f1', cid: 'bafy2' });
  });

  it('resolves the id via glob when the path exists but no id is known', async () => {
    const f = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/files?path='))
        return new Response(JSON.stringify({ error: 'already exists' }), {
          status: 409,
        });
      if (url.includes('/glob?pattern='))
        return json({ files: [{ id: 'f9', path: 'p' }] });
      if (url.endsWith('/files/f9')) return json({ id: 'f9', cid: 'c' });
      throw new Error(`unexpected ${url}`);
    });
    const result = await store(f).upload({
      userDid: 'did:ixo:u',
      storageKey: 'k1',
      openStream: () => Readable.from([Buffer.from('gz')]),
      sizeBytes: 2,
    });
    expect(result.pointer).toBe('f9');
  });

  it('download returns null on 404 — the one "no backup" answer', async () => {
    const f404 = vi.fn(async () => new Response('nope', { status: 404 }));
    expect(
      await store(f404).download({ userDid: 'did:ixo:u', storageKey: 'k1' }),
    ).toBeNull();
  });

  it('download rejects (never null) when the delegation is gone', async () => {
    // `null` would be read as "this user has no backup" and answered with a
    // fresh empty DB, which the next upload cycle writes over the real one.
    const fOk = vi.fn(async () => json({}));
    const thrown: unknown = await store(fOk, { delegation: 'none' })
      .download({ userDid: 'did:ixo:u', storageKey: 'k1' })
      .then(
        (value) => value,
        (error: unknown) => error,
      );
    expect(thrown).toBeInstanceOf(VfsAuthError);
    if (!(thrown instanceof VfsAuthError)) throw new Error('expected a throw');
    expect(thrown.kind).toBe('no-delegation');
    expect(fOk).not.toHaveBeenCalled();
  });

  it('download streams bytes and surfaces the content hash', async () => {
    const f = vi.fn(
      async () =>
        new Response(Buffer.from('gz-bytes'), {
          status: 200,
          headers: { 'content-length': '8', 'x-vfs-content-hash': 'h' },
        }),
    );
    const result = await store(f).download({
      userDid: 'did:ixo:u',
      storageKey: 'k1',
    });
    if (!result) throw new Error('expected a download');
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('gz-bytes');
    expect(result).toMatchObject({ sizeBytes: 8, contentHash: 'h' });
  });

  it('delete trashes then purges the file', async () => {
    const calls: string[] = [];
    const f = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/glob?'))
        return json({ files: [{ id: 'f1', path: 'p' }] });
      return json({ results: [{ id: 'f1', ok: true, status: 200 }] });
    });
    expect(
      await store(f).delete({ userDid: 'did:ixo:u', storageKey: 'k1' }),
    ).toBe(true);
    expect(calls.some((u) => u.endsWith('/batch/delete'))).toBe(true);
    expect(calls.some((u) => u.endsWith('/batch/purge'))).toBe(true);
  });

  it('gives a big upload a timeout it can actually finish in', () => {
    // A 3 GiB payload at the assumed 512 KiB/s floor needs ~102 minutes; the
    // flat 60s budget would abort it (and every retry) mid-transfer forever,
    // making the advertised 5 GiB cap unreachable.
    expect(uploadTimeoutMs(3 * 1024 * 1024 * 1024)).toBeGreaterThanOrEqual(
      100 * 60_000,
    );
    // Small payloads keep the base budget.
    expect(uploadTimeoutMs(0, 60_000)).toBe(60_000);
    expect(uploadTimeoutMs(512 * 1024, 60_000)).toBe(61_000);
  });

  it('propagates a 403 as an error (terminal, never a silent null)', async () => {
    const f = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }),
    );
    await expect(
      store(f).download({ userDid: 'did:ixo:u', storageKey: 'k1' }),
    ).rejects.toThrow();
  });
});

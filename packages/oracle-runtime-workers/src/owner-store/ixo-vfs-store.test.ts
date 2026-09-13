/**
 * IxoVfsOwnerStore over a fake VFS: the atomic replace (temp upload → delete
 * old → move into place), the single-shot vs. tus split, resume/retry, stale
 * temp cleanup, the occupied-destination recovery and streamed loads. Auth
 * is stubbed — the UCAN leg has its own tests.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  DelegatedCapability,
  WorkersUcanService,
} from '../do/ucan-service';
import {
  IxoVfsOwnerStore,
  ownerCopyCapability,
  SINGLE_SHOT_MAX_BYTES,
  TEMP_PATH_INFIX,
  VfsNoDelegationError,
  VfsRequestError,
} from './ixo-vfs-store';
import { measureForSave } from './measure';
import { bytesOfStream, gunzip, snapshotOfBytes } from './types';

const ORACLE = 'did:ixo:oracle';
const STATE_PATH = `/.oracles/${ORACLE}/state.db.gz`;

/** Deep-equal on multi-MB typed arrays blows the pool worker; compare digests. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return (
    a.byteLength === b.byteLength &&
    createHash('sha256').update(a).digest('hex') ===
      createHash('sha256').update(b).digest('hex')
  );
}

function sqliteBytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  out.set(new TextEncoder().encode('SQLite format 3\0'));
  // Incompressible body (xorshift32, high byte) so the gzip size tracks the input size.
  let x = seed * 2_654_435_761 + 1;
  for (let i = 16; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = (x >>> 24) & 0xff;
  }
  return out;
}

interface StoredFile {
  id: string;
  path: string;
  body: Uint8Array;
  contentHash: string;
}

interface FakeVfsOptions {
  /** Fail the n-th call of `POST /batch/delete` with 503 (1-based). */
  failDeleteCall?: number;
  /** Fail the n-th `GET /files` listing with 503 (1-based). */
  failListCall?: number;
  /** Fail the n-th single-shot `POST /files` with 503. */
  failCreateCall?: number;
  /** Fail the n-th tus PATCH with a dropped connection AFTER committing it. */
  dropPatchResponse?: number;
  /** Pre-seeded files. */
  seed?: Array<{ path: string; body: Uint8Array }>;
  /** Make the first move hit "Destination occupied" (a phantom occupant). */
  phantomOccupant?: boolean;
}

function fakeVfs(opts: FakeVfsOptions = {}) {
  const files = new Map<string, StoredFile>();
  const calls: string[] = [];
  let seq = 0;
  const hashOf = (b: Uint8Array) =>
    createHash('sha256').update(b).digest('hex');
  const create = (path: string, body: Uint8Array): StoredFile => {
    const file = { id: `f${++seq}`, path, body, contentHash: hashOf(body) };
    files.set(file.id, file);
    return file;
  };
  for (const s of opts.seed ?? []) create(s.path, s.body);
  let deleteCalls = 0;
  let listCalls = 0;
  let createCalls = 0;
  let patches = 0;
  let phantom = opts.phantomOccupant ?? false;
  const sessions = new Map<
    string,
    { path: string; total: number; offset: number; parts: Uint8Array[] }
  >();

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const p = url.pathname.replace(/^\/api\/fs/, '');
    calls.push(`${method} ${p}`);
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer inv');
    const body = async () =>
      new Uint8Array(await new Response(init?.body).arrayBuffer());

    if (method === 'GET' && p === '/files') {
      listCalls += 1;
      if (opts.failListCall === listCalls)
        return new Response('upstream unavailable', { status: 503 });
      const list = Array.from(files.values()).map((f) => ({
        id: f.id,
        path: f.path,
        size: f.body.byteLength,
        contentHash: f.contentHash,
      }));
      return Response.json({ files: list });
    }
    if (method === 'GET' && /^\/files\/[^/]+\/content$/.test(p)) {
      const id = p.split('/')[2]!;
      const file = files.get(id);
      if (!file) return Response.json({ error: 'not found' }, { status: 404 });
      return new Response(file.body, {
        headers: { 'content-type': 'application/gzip' },
      });
    }
    if (method === 'POST' && p === '/files') {
      createCalls += 1;
      if (opts.failCreateCall === createCalls)
        return Response.json({ error: 'boom' }, { status: 503 });
      const path = url.searchParams.get('path')!;
      if (Array.from(files.values()).some((f) => f.path === path))
        return Response.json({ error: 'exists' }, { status: 409 });
      const file = create(path, await body());
      return Response.json(
        { id: file.id, path, contentHash: file.contentHash },
        { status: 201 },
      );
    }
    if (method === 'POST' && p === '/batch/delete') {
      deleteCalls += 1;
      if (opts.failDeleteCall === deleteCalls)
        return Response.json({ error: 'boom' }, { status: 503 });
      const { ids } = JSON.parse(new TextDecoder().decode(await body())) as {
        ids: string[];
      };
      const results = ids.map((id) => {
        const ok = files.delete(id);
        return { id, ok, status: ok ? 200 : 404 };
      });
      return Response.json({ results });
    }
    if (method === 'POST' && p === '/batch/move') {
      const { items } = JSON.parse(new TextDecoder().decode(await body())) as {
        items: Array<{ id: string; destinationPath: string }>;
      };
      const results = items.map(({ id, destinationPath }) => {
        const file = files.get(id);
        if (!file) return { id, ok: false, status: 404, error: 'not found' };
        const occupied =
          phantom ||
          Array.from(files.values()).some(
            (f) => f.id !== id && f.path === destinationPath,
          );
        phantom = false;
        if (occupied)
          return {
            id,
            ok: false,
            status: 409,
            error: `Destination occupied: ${destinationPath}`,
          };
        file.path = destinationPath;
        return { id, ok: true, status: 200, path: destinationPath };
      });
      return Response.json({ results });
    }
    // tus
    if (method === 'POST' && p === '/upload') {
      const meta = Object.fromEntries(
        (headers.get('upload-metadata') ?? '').split(',').map((pair) => {
          const [k, v] = pair.split(' ');
          return [k, atob(v ?? '')];
        }),
      );
      const id = `s${++seq}`;
      sessions.set(id, {
        path: meta.path!,
        total: Number(headers.get('upload-length')),
        offset: 0,
        parts: [],
      });
      return new Response(null, {
        status: 201,
        headers: { location: `/api/fs/upload/${id}` },
      });
    }
    const tus = /^\/upload\/([^/]+)$/.exec(p);
    if (tus) {
      const session = sessions.get(tus[1]!);
      if (!session) return new Response(null, { status: 404 });
      if (method === 'HEAD')
        return new Response(null, {
          headers: { 'upload-offset': String(session.offset) },
        });
      if (method === 'DELETE') {
        sessions.delete(tus[1]!);
        return new Response(null, { status: 204 });
      }
      if (method === 'PATCH') {
        patches += 1;
        const part = await body();
        if (Number(headers.get('upload-offset')) !== session.offset)
          return new Response('offset', { status: 409 });
        session.parts.push(part);
        session.offset += part.byteLength;
        if (opts.dropPatchResponse === patches)
          throw new TypeError('fetch failed');
        if (session.offset === session.total) {
          const whole = new Uint8Array(session.total);
          let o = 0;
          for (const q of session.parts) {
            whole.set(q, o);
            o += q.byteLength;
          }
          sessions.delete(tus[1]!);
          const file = create(session.path, whole);
          return new Response(null, {
            status: 200,
            headers: {
              'x-vfs-file-id': file.id,
              'x-vfs-content-hash': file.contentHash,
            },
          });
        }
        return new Response(null, { status: 204 });
      }
    }
    return Response.json(
      { error: `unexpected ${method} ${p}` },
      { status: 500 },
    );
  };
  return {
    fetchImpl,
    calls,
    files,
    get patches() {
      return patches;
    },
    at: (path: string) =>
      Array.from(files.values()).filter((f) => f.path === path),
  };
}

/** The capability the Portal mints into the user's oracle delegation. */
const OWNER_COPY_GRANT = {
  can: '*',
  with: 'ixo:filesystem/.oracles',
  nb: { hidden: ['/.oracles'] },
};

interface UcanStubOptions {
  capabilities?: DelegatedCapability[];
  /** Every `createInvocationFromDelegation` call: `[rawDelegation, capability]`. */
  mints?: Array<[string, { can: string; with: string; nb?: unknown }]>;
}

function ucanStubWith(opts: UcanStubOptions = {}): WorkersUcanService {
  return {
    delegationCapabilities: async () => opts.capabilities ?? [OWNER_COPY_GRANT],
    createInvocationFromDelegation: async (
      raw: string,
      _url: string,
      capability: { can: string; with: string; nb?: unknown },
    ) => {
      opts.mints?.push([raw, capability]);
      return { invocation: 'inv' };
    },
  } as never as WorkersUcanService;
}

function makeStore(
  fetchImpl: typeof fetch,
  overrides: {
    ucan?: WorkersUcanService;
    delegation?: () => string | undefined;
  } = {},
): IxoVfsOwnerStore {
  return new IxoVfsOwnerStore({
    ucan: overrides.ucan ?? ucanStubWith(),
    userDid: 'did:ixo:user',
    oracleDid: ORACLE,
    vfsBaseUrl: 'https://vfs.test',
    delegation: overrides.delegation ?? (() => 'car'),
    fetchImpl,
    retryDelaysMs: [0, 0, 0],
    sleep: async () => undefined,
  });
}

describe('ownerCopyCapability', () => {
  const pick = (
    caps: Array<{ can: string; with: string }>,
    ability = 'fs/list',
  ) => ownerCopyCapability(caps, ability)?.with ?? null;

  it('accepts the personal filesystem or exactly its /.oracles subtree', () => {
    expect(pick([{ can: '*', with: 'ixo:filesystem' }])).toBe('ixo:filesystem');
    expect(pick([OWNER_COPY_GRANT])).toBe('ixo:filesystem/.oracles');
    expect(pick([{ can: '*', with: 'ixo:filesystem/.oracles/' }])).toBe(
      'ixo:filesystem/.oracles/',
    );
    expect(pick([{ can: '*', with: 'ixo:filesystem/' }])).toBe(
      'ixo:filesystem/',
    );
  });

  it('rejects narrower, sibling, domain and look-alike resources', () => {
    const rejected = [
      `ixo:filesystem/.oracles/${ORACLE}`,
      'ixo:filesystem/photos',
      'ixo:filesystem/did:ixo:entity:abc',
      'ixo:filesystemx',
      'ixo:memory',
    ].filter((w) => pick([{ can: '*', with: w }]) === null);
    expect(rejected).toHaveLength(5);
  });

  it('requires the ability to be covered and takes the first match', () => {
    expect(
      pick([{ can: 'fs/write', with: 'ixo:filesystem' }], 'fs/list'),
    ).toBeNull();
    expect(pick([{ can: 'fs/*', with: 'ixo:filesystem' }], 'fs/list')).toBe(
      'ixo:filesystem',
    );
    expect(
      pick(
        [
          { can: '*', with: 'ixo:memory' },
          { can: 'fs/list', with: 'ixo:filesystem/.oracles' },
          { can: '*', with: 'ixo:filesystem' },
        ],
        'fs/list',
      ),
    ).toBe('ixo:filesystem/.oracles');
  });
});

describe('IxoVfsOwnerStore auth: the one user→oracle delegation', () => {
  it('mints every request from that delegation, attenuated to the ability, revealing hidden files', async () => {
    const mints: NonNullable<UcanStubOptions['mints']> = [];
    const store = makeStore(fakeVfs().fetchImpl, {
      ucan: ucanStubWith({ mints }),
      delegation: () => 'the-users-car',
    });
    expect(await store.load()).toBeNull();
    expect(mints).toEqual([
      [
        'the-users-car',
        {
          can: 'fs/list',
          with: 'ixo:filesystem/.oracles',
          nb: { hidden: ['*'] },
        },
      ],
    ]);
  });

  it('is "not on VFS" when the user deposited no delegation at all', async () => {
    const store = makeStore(fakeVfs().fetchImpl, {
      delegation: () => undefined,
    });
    await expect(store.load()).rejects.toThrow(VfsNoDelegationError);
    await expect(store.load()).rejects.toThrow(
      /has not deposited a delegation/,
    );
  });

  it('is "not on VFS" when the delegation carries no file-storage capability over /.oracles', async () => {
    const store = makeStore(fakeVfs().fetchImpl, {
      ucan: ucanStubWith({
        capabilities: [
          { can: 'memory/*', with: 'ixo:memory' },
          { can: '*', with: 'ixo:filesystem/photos' },
        ],
      }),
    });
    await expect(store.load()).rejects.toThrow(VfsNoDelegationError);
    await expect(store.load()).rejects.toThrow(
      /carries no ixo:filesystem capability covering \/\.oracles/,
    );
  });
});

/** Method + path with the `?query` and temp-file suffix stripped, for ordering assertions. */
function shape(calls: string[]): string[] {
  return calls.map((c) => c.split('?')[0]!.replace(/\/s\d+$/, '/:session'));
}

describe('IxoVfsOwnerStore.save', () => {
  it('creates the file when none exists (small → single POST to a temp path, then move)', async () => {
    const vfs = fakeVfs();
    const data = sqliteBytes(50_000);
    const { etag, bytes } = await makeStore(vfs.fetchImpl).save(
      snapshotOfBytes(data),
    );
    expect(shape(vfs.calls)).toEqual([
      'GET /files',
      'POST /files',
      'POST /batch/move',
    ]);
    const [file] = vfs.at(STATE_PATH);
    expect(file).toBeDefined();
    expect(etag).toBe(file!.contentHash);
    expect(bytes).toBe(file!.body.byteLength);
    expect(sameBytes(await gunzip(file!.body), data)).toBe(true);
    expect(vfs.files.size).toBe(1);
  });

  it('replaces atomically: upload to temp, delete the old, move into place — never a PUT', async () => {
    const vfs = fakeVfs({
      seed: [{ path: STATE_PATH, body: new Uint8Array([1, 2, 3]) }],
    });
    const data = sqliteBytes(70_000, 3);
    const store = makeStore(vfs.fetchImpl);
    await store.save(snapshotOfBytes(data));
    expect(shape(vfs.calls)).toEqual([
      'GET /files',
      'POST /files',
      'POST /batch/delete',
      'POST /batch/move',
    ]);
    expect(vfs.calls.some((c) => c.startsWith('PUT'))).toBe(false);
    const files = vfs.at(STATE_PATH);
    expect(files).toHaveLength(1);
    expect(sameBytes(await gunzip(files[0]!.body), data)).toBe(true);
    expect(vfs.files.size).toBe(1);
    // head() sees the new file.
    expect((await store.head())?.etag).toBe(files[0]!.contentHash);
  });

  it('reads the snapshot once more when the caller measured the gzipped length, twice without', async () => {
    const counting = (data: Uint8Array) => {
      const opens = { n: 0 };
      const snapshot = {
        size: data.byteLength,
        open: () => {
          opens.n += 1;
          return snapshotOfBytes(data).open();
        },
      };
      return { snapshot, opens };
    };
    const small = sqliteBytes(50_000);
    const measured = await measureForSave(snapshotOfBytes(small).open());
    const withHint = counting(small);
    await makeStore(fakeVfs().fetchImpl).save(withHint.snapshot, {
      gzippedLength: measured.gzippedLength,
    });
    expect(withHint.opens.n).toBe(1);
    const withoutHint = counting(small);
    await makeStore(fakeVfs().fetchImpl).save(withoutHint.snapshot);
    expect(withoutHint.opens.n).toBe(2);
    // The same holds for the resumable (tus) path.
    const large = sqliteBytes(SINGLE_SHOT_MAX_BYTES * 2 + 123_456, 7);
    const largeMeasured = await measureForSave(snapshotOfBytes(large).open());
    const largeHint = counting(large);
    const { bytes } = await makeStore(fakeVfs().fetchImpl).save(
      largeHint.snapshot,
      { gzippedLength: largeMeasured.gzippedLength },
    );
    expect(largeHint.opens.n).toBe(1);
    expect(bytes).toBe(largeMeasured.gzippedLength);
  });

  it('streams a large file through tus parts (≥ 5 MiB each) and resumes a lost part response', async () => {
    const vfs = fakeVfs({ dropPatchResponse: 1 });
    const data = sqliteBytes(SINGLE_SHOT_MAX_BYTES * 2 + 123_456, 7);
    const { bytes } = await makeStore(vfs.fetchImpl).save(
      snapshotOfBytes(data),
    );
    const calls = shape(vfs.calls);
    expect(calls[0]).toBe('GET /files');
    expect(calls).toContain('POST /upload');
    expect(calls.filter((c) => c === 'PATCH /upload/:session').length).toBe(3);
    expect(calls).toContain('HEAD /upload/:session');
    expect(calls.at(-1)).toBe('POST /batch/move');
    const [file] = vfs.at(STATE_PATH);
    expect(sameBytes(await gunzip(file!.body), data)).toBe(true);
    expect(bytes).toBe(file!.body.byteLength);
    expect(bytes).toBeGreaterThan(SINGLE_SHOT_MAX_BYTES);
  });

  it('retries a transient failure of the delete step and still lands the file', async () => {
    const vfs = fakeVfs({
      seed: [{ path: STATE_PATH, body: new Uint8Array([9]) }],
      failDeleteCall: 1,
    });
    await makeStore(vfs.fetchImpl).save(snapshotOfBytes(sqliteBytes(1000)));
    expect(
      shape(vfs.calls).filter((c) => c === 'POST /batch/delete'),
    ).toHaveLength(2);
    expect(vfs.at(STATE_PATH)).toHaveLength(1);
  });

  it('head() retries a transient 503 on the listing instead of reporting the file absent', async () => {
    const vfs = fakeVfs({
      seed: [{ path: STATE_PATH, body: new Uint8Array([9]) }],
      failListCall: 1,
    });
    const head = await makeStore(vfs.fetchImpl).head();
    expect(head).not.toBeNull();
    expect(shape(vfs.calls).filter((c) => c === 'GET /files')).toHaveLength(2);
  });

  it('cleans up stale temp uploads from a crashed flush before uploading', async () => {
    const vfs = fakeVfs({
      seed: [
        { path: STATE_PATH, body: new Uint8Array([1]) },
        {
          path: `${STATE_PATH}${TEMP_PATH_INFIX}abc`,
          body: new Uint8Array([2]),
        },
      ],
    });
    await makeStore(vfs.fetchImpl).save(snapshotOfBytes(sqliteBytes(1000)));
    expect(vfs.files.size).toBe(1);
    expect(vfs.at(STATE_PATH)).toHaveLength(1);
    expect(
      shape(vfs.calls).filter((c) => c === 'POST /batch/delete'),
    ).toHaveLength(2); // stale temp, then the old file
  });

  it('recovers from "Destination occupied" by clearing the occupant and moving again', async () => {
    const vfs = fakeVfs({ phantomOccupant: true });
    await makeStore(vfs.fetchImpl).save(snapshotOfBytes(sqliteBytes(1000)));
    expect(
      shape(vfs.calls).filter((c) => c === 'POST /batch/move'),
    ).toHaveLength(2);
    expect(vfs.at(STATE_PATH)).toHaveLength(1);
  });

  it('propagates a fatal VFS answer (the object keeps the copy dirty and retries later)', async () => {
    const vfs = fakeVfs();
    const fetchImpl: typeof fetch = async (input, init) => {
      if ((init?.method ?? 'GET') === 'POST')
        return Response.json({ error: 'nope' }, { status: 403 });
      return vfs.fetchImpl(input, init);
    };
    const err = await makeStore(fetchImpl)
      .save(snapshotOfBytes(sqliteBytes(1000)))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VfsRequestError);
    expect((err as VfsRequestError).status).toBe(403);
  });
});

describe('IxoVfsOwnerStore.load', () => {
  it('streams and gunzips the stored file', async () => {
    const vfs = fakeVfs();
    const data = sqliteBytes(300_000, 11);
    const store = makeStore(vfs.fetchImpl);
    await store.save(snapshotOfBytes(data));
    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    expect(sameBytes(await bytesOfStream(loaded!.stream), data)).toBe(true);
    expect(loaded!.etag).toBe(vfs.at(STATE_PATH)[0]!.contentHash);
  });

  it('passes an uncompressed legacy upload through untouched', async () => {
    const raw = sqliteBytes(5000, 2);
    const vfs = fakeVfs({ seed: [{ path: STATE_PATH, body: raw }] });
    const loaded = await makeStore(vfs.fetchImpl).load();
    expect(sameBytes(await bytesOfStream(loaded!.stream), raw)).toBe(true);
  });

  it('returns null when the user has no state file', async () => {
    const vfs = fakeVfs();
    expect(await makeStore(vfs.fetchImpl).load()).toBeNull();
    expect(await makeStore(vfs.fetchImpl).head()).toBeNull();
  });
});

describe('IxoVfsOwnerStore.remove', () => {
  it('deletes the state file and any temp leftovers', async () => {
    const vfs = fakeVfs({
      seed: [
        { path: STATE_PATH, body: new Uint8Array([1]) },
        { path: `${STATE_PATH}${TEMP_PATH_INFIX}x`, body: new Uint8Array([2]) },
        {
          path: '/.oracles/did:ixo:other/state.db.gz',
          body: new Uint8Array([3]),
        },
      ],
    });
    await makeStore(vfs.fetchImpl).remove();
    expect(vfs.files.size).toBe(1);
    expect(vfs.at('/.oracles/did:ixo:other/state.db.gz')).toHaveLength(1);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { VfsNoDelegationError } from './ixo-vfs-store';
import { MigratingOwnerStore } from './migrating-store';
import {
  bytesOfStream,
  snapshotOfBytes,
  streamOfBytes,
  type OwnerStore,
} from './types';

/** In-memory OwnerStore double. */
function memStore(kind: 'matrix' | 'vfs', opts: { failSave?: boolean } = {}) {
  let file: { bytes: Uint8Array; etag: string } | null = null;
  let version = 0;
  const store: OwnerStore = {
    kind,
    load: async () =>
      file ? { stream: streamOfBytes(file.bytes), etag: file.etag } : null,
    save: async (snapshot) => {
      if (opts.failSave) throw new Error(`${kind} save unavailable`);
      const bytes = await bytesOfStream(snapshot.open());
      version += 1;
      file = { bytes, etag: `${kind}-v${version}` };
      return { etag: file.etag, bytes: bytes.byteLength };
    },
    head: async () => (file ? { etag: file.etag } : null),
    remove: async () => {
      file = null;
    },
  };
  return {
    store,
    seed: (bytes: Uint8Array) => {
      version += 1;
      file = { bytes, etag: `${kind}-v${version}` };
    },
    get file() {
      return file;
    },
  };
}

const bytes = (...values: number[]) => new Uint8Array(values);
const noopLog = () => undefined;

describe('MigratingOwnerStore', () => {
  it('prefers the VFS copy and never touches legacy when VFS has the file', async () => {
    const vfs = memStore('vfs');
    const legacy = memStore('matrix');
    vfs.seed(bytes(1, 2, 3));
    legacy.seed(bytes(9, 9, 9));
    const legacyLoad = vi.spyOn(legacy.store, 'load');

    const store = new MigratingOwnerStore({
      primary: vfs.store,
      legacy: legacy.store,
      log: noopLog,
    });
    const loaded = await store.load();
    expect(await bytesOfStream(loaded!.stream)).toEqual(bytes(1, 2, 3));
    expect(loaded?.etag).toBe('vfs-v1');
    expect(legacyLoad).not.toHaveBeenCalled();
    expect((await store.head())?.etag).toBe('vfs-v1');
  });

  it('migrates a legacy Matrix file into VFS on first load, then serves from VFS', async () => {
    const vfs = memStore('vfs');
    const legacy = memStore('matrix');
    legacy.seed(bytes(4, 5, 6));

    const store = new MigratingOwnerStore({
      primary: vfs.store,
      legacy: legacy.store,
      log: noopLog,
    });
    const loaded = await store.load();
    expect(await bytesOfStream(loaded!.stream)).toEqual(bytes(4, 5, 6));
    // The returned etag is the NEW VFS version — the working copy tracks VFS.
    expect(loaded?.etag).toBe('vfs-v1');
    expect(vfs.file?.bytes).toEqual(bytes(4, 5, 6));
    // Legacy copy intentionally left in place; head() now answers from VFS.
    expect(legacy.file).not.toBeNull();
    expect((await store.head())?.etag).toBe('vfs-v1');
  });

  it('serves the legacy copy when the migration write fails, without losing it', async () => {
    const vfs = memStore('vfs', { failSave: true });
    const legacy = memStore('matrix');
    legacy.seed(bytes(7, 7));

    const store = new MigratingOwnerStore({
      primary: vfs.store,
      legacy: legacy.store,
      log: noopLog,
    });
    const loaded = await store.load();
    expect(await bytesOfStream(loaded!.stream)).toEqual(bytes(7, 7));
    expect(loaded?.etag).toBe('matrix-v1');
    expect((await store.head())?.etag).toBe('matrix-v1');
  });

  it('saves to VFS only; every failure propagates (the object keeps the copy dirty) and Matrix is never written', async () => {
    const vfs = memStore('vfs');
    const legacy = memStore('matrix');
    const legacySave = vi.spyOn(legacy.store, 'save');

    const store = new MigratingOwnerStore({
      primary: vfs.store,
      legacy: legacy.store,
      log: noopLog,
    });
    const saved = await store.save(snapshotOfBytes(bytes(1)));
    expect(saved.etag).toBe('vfs-v1');

    const broken = new MigratingOwnerStore({
      primary: memStore('vfs', { failSave: true }).store,
      legacy: legacy.store,
      log: noopLog,
    });
    await expect(broken.save(snapshotOfBytes(bytes(2)))).rejects.toThrow(
      /vfs save unavailable/,
    );

    const notOnVfs = new MigratingOwnerStore({
      primary: {
        ...memStore('vfs').store,
        save: async () => {
          throw new VfsNoDelegationError('did:ixo:user');
        },
      },
      legacy: legacy.store,
      log: noopLog,
    });
    await expect(notOnVfs.save(snapshotOfBytes(bytes(3)))).rejects.toThrow(
      VfsNoDelegationError,
    );
    expect(legacySave).not.toHaveBeenCalled();
    expect(legacy.file).toBeNull();
  });

  it('removeLegacyCopy() redacts the Matrix copy only once VFS holds the expected etag', async () => {
    const vfs = memStore('vfs');
    const legacy = memStore('matrix');
    legacy.seed(bytes(9, 9));
    const store = new MigratingOwnerStore({
      primary: vfs.store,
      legacy: legacy.store,
      log: noopLog,
    });
    // VFS has nothing yet: nothing is removed.
    expect(await store.removeLegacyCopy('vfs-v1')).toBe(false);
    expect(legacy.file).not.toBeNull();
    // VFS holds a different version than the caller confirmed: kept.
    await store.save(snapshotOfBytes(bytes(1)));
    expect(await store.removeLegacyCopy('vfs-v0')).toBe(false);
    expect(legacy.file).not.toBeNull();
    // Confirmed: removed, and a second call finds nothing.
    expect(await store.removeLegacyCopy('vfs-v1')).toBe(true);
    expect(legacy.file).toBeNull();
    expect(await store.removeLegacyCopy('vfs-v1')).toBe(false);
    // head()/load() keep serving VFS.
    expect(await store.head()).toEqual({ etag: 'vfs-v1' });
  });

  it('head() propagates a VFS error instead of reporting the file absent', async () => {
    const legacy = memStore('matrix');
    legacy.seed(bytes(1));
    const store = new MigratingOwnerStore({
      primary: {
        ...memStore('vfs').store,
        head: async () => {
          throw new Error('VFS list unavailable');
        },
      },
      legacy: legacy.store,
      log: noopLog,
    });
    // A transient VFS failure must NOT fall through to "absent" (which a boot
    // would read as an upstream deletion) — it must throw.
    await expect(store.head()).rejects.toThrow(/VFS list unavailable/);
  });

  it('load() without a VFS delegation throws when there is no legacy copy (never "no file")', async () => {
    const noDelegation = {
      ...memStore('vfs').store,
      load: async () => {
        throw new VfsNoDelegationError('did:ixo:user');
      },
    };
    const empty = new MigratingOwnerStore({
      primary: noDelegation,
      legacy: memStore('matrix').store,
      log: noopLog,
    });
    await expect(empty.load()).rejects.toThrow(VfsNoDelegationError);

    // A legacy copy is still served (its migration write fails softly).
    const legacy = memStore('matrix');
    legacy.seed(bytes(7, 7, 7));
    const withLegacy = new MigratingOwnerStore({
      primary: {
        ...noDelegation,
        save: async () => {
          throw new VfsNoDelegationError('did:ixo:user');
        },
      },
      legacy: legacy.store,
      log: noopLog,
    });
    const served = await withLegacy.load();
    expect(served && (await bytesOfStream(served.stream))).toEqual(
      bytes(7, 7, 7),
    );
  });

  it('remove() clears both copies', async () => {
    const vfs = memStore('vfs');
    const legacy = memStore('matrix');
    vfs.seed(bytes(1));
    legacy.seed(bytes(2));
    const store = new MigratingOwnerStore({
      primary: vfs.store,
      legacy: legacy.store,
      log: noopLog,
    });
    await store.remove();
    expect(vfs.file).toBeNull();
    expect(legacy.file).toBeNull();
    expect(await store.head()).toBeNull();
  });
  it('loadLegacy() returns the Matrix copy even when VFS already holds a file (never-chatted object flushed an empty one)', async () => {
    const vfs = memStore('vfs');
    const legacy = memStore('matrix');
    vfs.seed(bytes(0));
    legacy.seed(bytes(7, 7, 7));
    const store = new MigratingOwnerStore({
      primary: vfs.store,
      legacy: legacy.store,
      log: noopLog,
    });
    // The normal path still prefers VFS…
    expect((await store.load())?.etag).toBe('vfs-v1');
    // …but the legacy copy stays reachable for the object's zero-turn adoption.
    expect(await bytesOfStream((await store.loadLegacy())!.stream)).toEqual(
      bytes(7, 7, 7),
    );
    expect(vfs.file?.etag).toBe('vfs-v1');

    const noLegacy = new MigratingOwnerStore({
      primary: vfs.store,
      legacy: memStore('matrix').store,
      log: noopLog,
    });
    expect(await noLegacy.loadLegacy()).toBeNull();
  });

  it('loadLegacy() treats a legacy failure as "no copy"', async () => {
    const legacy = memStore('matrix');
    vi.spyOn(legacy.store, 'load').mockRejectedValue(new Error('room gone'));
    const store = new MigratingOwnerStore({
      primary: memStore('vfs').store,
      legacy: legacy.store,
      log: noopLog,
    });
    expect(await store.loadLegacy()).toBeNull();
  });
});

/**
 * The default owner store: **IXO VFS is the system of record**; the user's
 * Matrix room media is only a read-only *legacy* source, checked when VFS has
 * no file yet so users coming from the Node runtime keep their history.
 *
 *   load():  VFS first. If absent there but present in Matrix media, hand
 *            the legacy stream over flagged `fromLegacy`: the object imports
 *            it chunk by chunk and writes it to VFS from its working copy at
 *            once (`flushToOwnerStore`) — from that moment the VFS copy is
 *            authoritative and Matrix is never consulted again (head() sees
 *            the VFS file). Nothing on this path holds the file in memory.
 *   save():  VFS, and only VFS. Nothing is ever written to Matrix media any
 *            more: a failed VFS write (no `ixo:filesystem` delegation yet, a
 *            VFS outage) propagates, and the object keeps its working copy
 *            dirty in Durable Object storage and retries.
 *   head():  VFS if a file exists there, else legacy.
 *   remove(): both (the user asked to be forgotten).
 *   removeLegacyCopy(etag): once the VFS copy is confirmed (its etag matches
 *            what the caller just uploaded or loaded), redact the legacy
 *            Matrix copy so no second copy of the user's history lingers.
 */
import { VfsNoDelegationError } from './ixo-vfs-store';
import type { FileSnapshot, OwnerCopy, OwnerStore, SaveResult } from './types';

export interface MigratingOwnerStoreOptions {
  /** System of record (IXO VFS). */
  primary: OwnerStore;
  /** Read-mostly legacy source (Matrix room media). */
  legacy: OwnerStore;
  log?: (level: 'log' | 'warn' | 'error', message: string) => void;
}

export class MigratingOwnerStore implements OwnerStore {
  readonly kind = 'vfs' as const;
  private readonly primary: OwnerStore;
  private readonly legacy: OwnerStore;
  private readonly log: (
    level: 'log' | 'warn' | 'error',
    message: string,
  ) => void;

  constructor(opts: MigratingOwnerStoreOptions) {
    this.primary = opts.primary;
    this.legacy = opts.legacy;
    this.log =
      opts.log ??
      ((level, message) => {
        // eslint-disable-next-line no-console -- console IS the logger on Workers
        console[level](message);
      });
  }

  async load(): Promise<OwnerCopy | null> {
    // "Not on VFS yet" (no ixo:filesystem delegation deposited) means *no VFS
    // copy* — fall through to the legacy source so the user's boot works and
    // their Matrix history stays reachable. Any OTHER failure (store/VFS
    // outage) still throws: silently serving a stale legacy copy to a user
    // whose system of record IS the VFS would fork their history.
    let fromVfs: OwnerCopy | null;
    let noDelegation: VfsNoDelegationError | null = null;
    try {
      fromVfs = await this.primary.load();
    } catch (err) {
      if (!(err instanceof VfsNoDelegationError)) throw err;
      this.log(
        'warn',
        `[owner-store] ${err.message} — this user is not on VFS yet; checking legacy Matrix media`,
      );
      noDelegation = err;
      fromVfs = null;
    }
    if (fromVfs) return fromVfs;

    const fromLegacy = await this.legacy.load().catch((err) => {
      this.log(
        'warn',
        `[owner-store] legacy Matrix load failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    });
    if (!fromLegacy) {
      // Without a delegation VFS could not be READ, so "no legacy copy" is
      // not "no file": an existing user whose grant lapsed would otherwise
      // start with an empty history (and later flush it over the real
      // copy). Only a successful VFS listing may say the user has no file.
      if (noDelegation) throw noDelegation;
      return null;
    }

    // One-time migration, streamed: the object imports this copy chunk by
    // chunk and then flushes its working copy to VFS (`fromLegacy`). Writing
    // VFS from here would need the whole file in memory twice over (the VFS
    // store measures the gzip before it uploads) — what used to reset the
    // isolate on large Node-era histories.
    this.log(
      'log',
      `[owner-store] legacy Matrix copy ${fromLegacy.etag} found and no VFS copy yet — importing it for migration`,
    );
    return { ...fromLegacy, fromLegacy: true };
  }

  /**
   * Write to the system of record. Every failure propagates — including
   * "not on VFS yet" (no delegation) — so the object keeps the copy dirty
   * and retries; Matrix media is never written.
   */
  async save(snapshot: FileSnapshot): Promise<SaveResult> {
    return this.primary.save(snapshot);
  }

  /**
   * Delete the legacy Matrix copy once VFS is confirmed to hold the file:
   * the VFS `head()` etag must equal `expectedEtag` (the etag the caller just
   * uploaded or loaded), otherwise nothing is touched. Returns true when a
   * legacy copy existed and was removed.
   */
  async removeLegacyCopy(expectedEtag: string): Promise<boolean> {
    const legacyHead = await this.legacy.head();
    if (!legacyHead) return false;
    const vfsHead = await this.primary.head();
    if (!vfsHead || vfsHead.etag !== expectedEtag) {
      this.log(
        'warn',
        `[owner-store] legacy Matrix copy kept: VFS copy not confirmed (have ${vfsHead?.etag ?? 'none'}, expected ${expectedEtag})`,
      );
      return false;
    }
    await this.legacy.remove('Migrated to IXO VFS');
    this.log(
      'log',
      `[owner-store] removed the legacy Matrix copy (${legacyHead.etag}); VFS ${vfsHead.etag} is the only copy now`,
    );
    return true;
  }

  async head(): Promise<{ etag: string } | null> {
    // Errors PROPAGATE: a caller must be able to tell "the file is absent"
    // (null) from "could not check" (throw). Swallowing a VFS error to null
    // here would let a boot read a transient outage as an upstream deletion.
    // Only fall through to legacy when VFS positively has no file.
    const vfs = await this.primary.head();
    if (vfs) return vfs;
    return this.legacy.head().catch(() => null);
  }

  /** The legacy Matrix copy regardless of what VFS holds (see `OwnerStore.loadLegacy`). */
  async loadLegacy(): Promise<OwnerCopy | null> {
    try {
      const copy = await this.legacy.load();
      return copy ? { ...copy, fromLegacy: true } : null;
    } catch (err) {
      this.log(
        'warn',
        `[owner-store] legacy Matrix load failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  async remove(): Promise<void> {
    await this.primary.remove().catch((err) => {
      this.log(
        'warn',
        `[owner-store] VFS remove failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    await this.legacy.remove().catch((err) => {
      this.log(
        'warn',
        `[owner-store] legacy Matrix remove failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
}

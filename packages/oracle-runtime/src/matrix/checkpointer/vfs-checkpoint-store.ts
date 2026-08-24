import { Logger } from '@nestjs/common';
import {
  mintVfsBearerFor,
  type VfsDelegationMinter,
} from '../../plugins/vfs/vfs-auth.js';
import { VfsClient } from '../../plugins/vfs/vfs-client.js';
import { isAlreadyExistsConflict } from '../../plugins/vfs/vfs-errors.js';
import type { VfsWorkerUrls } from '../../plugins/vfs/vfs-network.js';
import type {
  CheckpointBackupStore,
  CheckpointDownloadResult,
  CheckpointUploadParams,
  CheckpointUploadResult,
} from './checkpoint-backup-store.js';

const VFS_API_BASE_PATH = '/api/fs';
const BACKUP_MIME = 'application/gzip';
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Slowest uplink a backup upload is expected to sustain. The client's timeout
 * bounds the WHOLE request including body transfer, so a fixed one silently
 * caps the backup size at `timeout x uplink` — well below the 5 GiB the store
 * advertises — and a user above that cap re-snapshots, re-gzips and times out
 * every cron tick forever. Scaling the budget with the payload keeps the
 * advertised cap reachable while still failing a genuinely stalled transfer.
 */
const MIN_UPLOAD_BYTES_PER_SECOND = 512 * 1024;

/**
 * Downloads cannot size their budget up front (the body length is only known
 * once the response arrives), so they get one flat, generous budget instead:
 * a restore is on the request path and a slow-but-progressing transfer is far
 * better than a 500 the user has to retry.
 */
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

/**
 * Whole-request timeout for uploading `sizeBytes`: the base budget plus the
 * time {@link MIN_UPLOAD_BYTES_PER_SECOND} needs to push the payload.
 */
export function uploadTimeoutMs(
  sizeBytes: number,
  base: number = DEFAULT_TIMEOUT_MS,
): number {
  return Math.max(
    base,
    Math.ceil(sizeBytes / MIN_UPLOAD_BYTES_PER_SECOND) * 1000 + base,
  );
}

/**
 * VFS upload cap for checkpoint backups — replaces the Matrix homeserver's
 * `m.upload.size` (typically 100 MiB) as the size guard once a user is on
 * this store, so the Matrix media cap stops being a constraint on checkpoint
 * size for VFS-backed users.
 */
export const VFS_UPLOAD_SIZE_LIMIT_BYTES = 5 * 1024 * 1024 * 1024;

export interface VfsCheckpointStoreDeps {
  minter: VfsDelegationMinter;
  urls: VfsWorkerUrls;
  oracleEntityDid: string;
  /** VFS file id recorded for a storage key on an earlier upload, if any. */
  knownFileId: (storageKey: string) => string | undefined;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Checkpoint backups as a single gzip file in the user's own VFS namespace,
 * under the subtree the user delegated to this oracle. Every request mints a
 * fresh single-use invocation from the user's deposited delegation.
 */
export class VfsCheckpointStore implements CheckpointBackupStore {
  readonly kind = 'vfs' as const;

  private readonly logger = new Logger(VfsCheckpointStore.name);

  constructor(private readonly deps: VfsCheckpointStoreDeps) {}

  static backupPath(oracleEntityDid: string, storageKey: string): string {
    return `oracle-data/${oracleEntityDid}/${storageKey}.db.gz`;
  }

  /**
   * A client for one operation. `timeoutMs` is per operation because the
   * budget depends on how many bytes that operation moves — an explicit
   * `deps.timeoutMs` (tests) always wins.
   */
  private client(
    userDid: string,
    timeoutMs: number = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  ): VfsClient {
    const { urls } = this.deps;
    return new VfsClient({
      baseUrl: `${urls.vfs.replace(/\/+$/, '')}${VFS_API_BASE_PATH}`,
      timeoutMs,
      fetchImpl: this.deps.fetchImpl,
      mint: (ability) =>
        mintVfsBearerFor(
          this.deps.minter,
          userDid,
          { VFS_BASE_URL: urls.vfs, UCAN_STORE_URL: urls.store },
          ability,
        ),
    });
  }

  async available(userDid: string): Promise<boolean> {
    const delegation = await this.deps.minter.getServiceDelegation(userDid, {
      storeUrl: this.deps.urls.store,
      resource: 'ixo:filesystem',
      requiredAbility: 'fs/write',
    });
    return !('error' in delegation);
  }

  async upload(
    params: CheckpointUploadParams,
  ): Promise<CheckpointUploadResult> {
    const client = this.client(
      params.userDid,
      uploadTimeoutMs(
        params.sizeBytes,
        this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ),
    );
    const path = VfsCheckpointStore.backupPath(
      this.deps.oracleEntityDid,
      params.storageKey,
    );
    const body = {
      open: params.openStream,
      sizeBytes: params.sizeBytes,
      mime: BACKUP_MIME,
    };
    try {
      const created = await client.createStream(path, body);
      // An unparseable 2xx yields an id-less stub. Persisting that empty
      // pointer would strand the key: every later cycle 409s and can never
      // resolve an id to replace. Fail the cycle instead — the next tick
      // retries and the 409 path resolves the id via `statByPath`.
      if (!created.id) {
        throw new Error(
          `VFS accepted the checkpoint upload for ${path} but returned no file id`,
        );
      }
      return { pointer: created.id, cid: created.cid };
    } catch (err) {
      if (!isAlreadyExistsConflict(err)) throw err;
    }
    // `||`, not `??`: a recorded-but-empty id is a missing id, and must fall
    // through to path resolution rather than short-circuit it.
    const id =
      this.deps.knownFileId(params.storageKey) ||
      (await client.statByPath(path))?.id;
    if (!id) {
      throw new Error(
        `VFS reports ${path} exists but its id could not be resolved`,
      );
    }
    const replaced = await client.replaceStream(id, body);
    return { pointer: replaced.id || id, cid: replaced.cid };
  }

  /**
   * `null` means exactly one thing: the worker says there is no such file
   * (the client maps its 404 to `null`). Every other failure — an expired or
   * revoked delegation, an unreachable UCAN store, a failed mint, a 403, a
   * 5xx — propagates. "I can't reach your backup right now" must never be
   * reported as "you have no backup": the caller treats `null` as no-backup
   * and starts a fresh, empty database, which the next upload cycle would
   * then write over the real one.
   */
  async download(params: {
    userDid: string;
    storageKey: string;
  }): Promise<CheckpointDownloadResult | null> {
    const path = VfsCheckpointStore.backupPath(
      this.deps.oracleEntityDid,
      params.storageKey,
    );
    const content = await this.client(
      params.userDid,
      this.deps.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
    ).contentStreamByPath(path);
    if (!content) return null;
    return {
      stream: content.stream,
      sizeBytes: content.sizeBytes,
      contentHash: content.contentHash,
    };
  }

  async delete(params: {
    userDid: string;
    storageKey: string;
  }): Promise<boolean> {
    const client = this.client(params.userDid);
    const path = VfsCheckpointStore.backupPath(
      this.deps.oracleEntityDid,
      params.storageKey,
    );
    // `||`: an empty recorded id is a missing id (see `upload`).
    const id =
      this.deps.knownFileId(params.storageKey) ||
      (await client.statByPath(path))?.id;
    if (!id) return false;
    const trashed = await client.trash([id]);
    if (!trashed.some((r) => r.id === id && r.ok)) return false;
    const purged = await client.purge([id]);
    if (!purged.some((r) => r.id === id && r.ok)) {
      this.logger.warn(`Trashed but could not purge VFS backup ${path}`);
    }
    return true;
  }
}

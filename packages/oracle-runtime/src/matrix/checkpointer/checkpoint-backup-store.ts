import type { Readable } from 'node:stream';

export type CheckpointStoreKind = 'vfs' | 'matrix';

export interface CheckpointUploadParams {
  userDid: string;
  storageKey: string;
  /** Re-openable: a retry must re-read the temp file from the start. */
  openStream: () => Readable;
  sizeBytes: number;
}

export interface CheckpointUploadResult {
  /** Store-specific handle (Matrix event id / VFS file id) persisted in file_events. */
  pointer: string;
  cid?: string;
  /** Matrix only: the media event, cached for offline re-download. */
  event?: unknown;
}

export interface CheckpointDownloadResult {
  stream: Readable;
  sizeBytes?: number;
  /** Store-computed hash of the bytes, verified by the caller when present. */
  contentHash?: string;
}

/**
 * The downloaded bytes did not match the hash the store reported for them.
 * A distinct type (not a plain `Error`) because the restore path classifies
 * unknown errors by message, and `/hash/` + `/mismatch/` there mean "safe to
 * start fresh" — the opposite of what an integrity failure means. The store
 * copy is re-fetchable, so a mismatch is transient: fail the restore, keep
 * the backup, retry on the next request.
 */
export class CheckpointIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointIntegrityError';
  }
}

export interface CheckpointBackupStore {
  readonly kind: CheckpointStoreKind;
  upload(params: CheckpointUploadParams): Promise<CheckpointUploadResult>;
  download(params: {
    userDid: string;
    storageKey: string;
  }): Promise<CheckpointDownloadResult | null>;
  delete(params: { userDid: string; storageKey: string }): Promise<boolean>;
  available(userDid: string): Promise<boolean>;
}

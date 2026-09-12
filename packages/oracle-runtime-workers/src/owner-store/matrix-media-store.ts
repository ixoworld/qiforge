/**
 * `OwnerStore` backed by the user's Matrix room, through the gateway object.
 *
 * Wire format is the Node runtime's (`m.ixo.media_upload` timeline event +
 * `m.ixo.media_state[storageKey]` pointer), so a user migrating from the
 * Node runtime finds their checkpoint file where they left it. The gateway
 * moves the media across the object boundary as a stream, as stored; this
 * class decrypts, gunzips and header-checks it chunk by chunk (and gzips +
 * hands over a stream on the way up), so the file is never held whole in
 * either isolate — a 50 MB Node-era history used to be materialised three
 * times over in the user object and reset its 128 MB isolate.
 */

import { createAttachmentDecryptor } from '@ixo/matrix-bot-workers-sdk';
import type { MatrixGatewayObject } from '../do/contracts';
import {
  assertSqliteStream,
  countStream,
  gunzipStreamIfNeeded,
  gzipStream,
  type FileSnapshot,
  type OwnerCopy,
  type OwnerStore,
  type SaveResult,
} from './types';

/**
 * The slice of the gateway RPC surface this store needs — structurally
 * satisfied by `DurableObjectStub<MatrixGatewayObject>` and faked in tests.
 */
export type SnapshotGateway = Pick<
  MatrixGatewayObject,
  | 'downloadUserSnapshotStream'
  | 'uploadUserSnapshotStream'
  | 'resolveUserRoom'
  | 'getRoomStateEvent'
  | 'sendEvent'
  | 'sendStateEvent'
>;

export interface MatrixMediaOwnerStoreOptions {
  gateway: SnapshotGateway;
  userDid: string;
  storageKey: string;
}

export class MatrixMediaOwnerStore implements OwnerStore {
  readonly kind = 'matrix' as const;
  private readonly gateway: SnapshotGateway;
  private readonly userDid: string;
  private readonly storageKey: string;

  constructor(opts: MatrixMediaOwnerStoreOptions) {
    this.gateway = opts.gateway;
    this.userDid = opts.userDid;
    this.storageKey = opts.storageKey;
  }

  private get filename(): string {
    return `${this.storageKey}.db.gz`;
  }

  /**
   * Streamed end to end: the gateway hands the media over as stored (the
   * ciphertext plus its `EncryptedFile` fields in an E2EE room, the plain
   * upload otherwise), this side decrypts and gunzips as the bytes arrive and
   * rejects anything that does not start like a SQLite file before the object
   * writes a single chunk. A hash mismatch surfaces at the END of the stream
   * (the SDK verifies the ciphertext SHA-256 once the last byte is in), which
   * fails the import and leaves the working copy untouched. Peak memory is a
   * few chunks, whatever the file size.
   */
  async load(): Promise<OwnerCopy | null> {
    const found = await this.gateway.downloadUserSnapshotStream(
      this.userDid,
      this.storageKey,
    );
    if (!found) return null;
    const plain = found.file
      ? found.stream.pipeThrough(createAttachmentDecryptor(found.file))
      : found.stream;
    // Old Node-runtime uploads were always gzipped, but tolerate a raw file
    // so a hand-uploaded database still loads.
    const stream = await assertSqliteStream(
      await gunzipStreamIfNeeded(plain),
      `MatrixMediaOwnerStore: snapshot ${found.eventId} for ${this.storageKey}`,
    );
    return { stream, etag: found.eventId };
  }

  /**
   * Streamed as well: the snapshot is opened three times — a header peek, a
   * gzip pass that only counts (the homeserver needs the exact ciphertext
   * length up front; gzip output is deterministic for identical input, the
   * VFS store relies on the same property) and the gzip pass that is
   * uploaded — and never held whole.
   */
  async save(snapshot: FileSnapshot): Promise<SaveResult> {
    const checked = await assertSqliteStream(
      snapshot.open(),
      `MatrixMediaOwnerStore: refusing to save — the working copy (${snapshot.size} bytes)`,
    );
    await checked.cancel().catch(() => undefined);
    const gzLength = await countStream(gzipStream(snapshot.open()));
    const { eventId } = await this.gateway.uploadUserSnapshotStream(
      this.userDid,
      this.storageKey,
      gzipStream(snapshot.open()),
      this.filename,
      gzLength,
    );
    return { etag: eventId, bytes: gzLength };
  }

  async head(): Promise<{ etag: string } | null> {
    const room = await this.gateway.resolveUserRoom(this.userDid);
    if (!room) return null;
    const eventId = await this.currentEventId(room.roomId);
    return eventId ? { etag: eventId } : null;
  }

  async remove(reason = 'User requested deletion'): Promise<void> {
    const room = await this.gateway.resolveUserRoom(this.userDid);
    if (!room) return;
    const eventId = await this.currentEventId(room.roomId);
    if (eventId) {
      // The gateway routes `m.room.redaction` through the redaction endpoint.
      await this.gateway.sendEvent(
        room.roomId,
        'm.room.redaction',
        JSON.stringify({ redacts: eventId, reason }),
      );
    }
    // Clear the pointer so `head()`/`load()` report "nothing" from now on.
    await this.gateway.sendStateEvent(
      room.roomId,
      'm.ixo.media_state',
      JSON.stringify({}),
      this.storageKey,
    );
  }

  /** `m.ixo.media_state[storageKey].eventId`, or null when unset/cleared. */
  private async currentEventId(roomId: string): Promise<string | null> {
    const json = await this.gateway.getRoomStateEvent(
      roomId,
      'm.ixo.media_state',
      this.storageKey,
    );
    if (!json) return null;
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const eventId = (parsed as Record<string, unknown>)['eventId'];
    return typeof eventId === 'string' && eventId.length > 0 ? eventId : null;
  }
}

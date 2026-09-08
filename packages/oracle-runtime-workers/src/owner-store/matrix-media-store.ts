/**
 * `OwnerStore` backed by the user's Matrix room, through the gateway object.
 *
 * Wire format is the Node runtime's (`m.ixo.media_upload` timeline event +
 * `m.ixo.media_state[storageKey]` pointer), so a user migrating from the
 * Node runtime finds their checkpoint file where they left it. The gateway
 * handles encryption and media transfer; this class owns gzip and the
 * SQLite sanity check.
 */

import type { MatrixGatewayObject } from '../do/contracts';
import {
  bytesOfStream,
  gunzip,
  gzip,
  isSqliteFile,
  streamOfBytes,
  type FileSnapshot,
  type OwnerCopy,
  type OwnerStore,
  type SaveResult,
} from './types';

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

function looksGzipped(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 2 && bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1
  );
}

export interface MatrixMediaOwnerStoreOptions {
  gateway: DurableObjectStub<MatrixGatewayObject>;
  userDid: string;
  storageKey: string;
}

export class MatrixMediaOwnerStore implements OwnerStore {
  readonly kind = 'matrix' as const;
  private readonly gateway: DurableObjectStub<MatrixGatewayObject>;
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
   * The gateway RPC hands the whole (encrypted, then decrypted) media blob
   * over; this path is the legacy one and inherently materializes the file.
   */
  async load(): Promise<OwnerCopy | null> {
    const found = await this.gateway.downloadUserSnapshot(
      this.userDid,
      this.storageKey,
    );
    if (!found) return null;
    // Old Node-runtime uploads were always gzipped, but tolerate a raw file
    // so a hand-uploaded database still loads.
    const bytes = looksGzipped(found.bytes)
      ? await gunzip(found.bytes)
      : found.bytes;
    if (!isSqliteFile(bytes)) {
      throw new Error(
        `MatrixMediaOwnerStore: snapshot ${found.eventId} for ${this.storageKey} is not a SQLite file (${bytes.length} bytes)`,
      );
    }
    return { stream: streamOfBytes(bytes), etag: found.eventId };
  }

  async save(snapshot: FileSnapshot): Promise<SaveResult> {
    const bytes = await bytesOfStream(snapshot.open());
    if (!isSqliteFile(bytes)) {
      throw new Error(
        `MatrixMediaOwnerStore: refusing to save ${bytes.length} bytes that are not a SQLite file`,
      );
    }
    const compressed = await gzip(bytes);
    const { eventId } = await this.gateway.uploadUserSnapshot(
      this.userDid,
      this.storageKey,
      compressed,
      this.filename,
    );
    return { etag: eventId, bytes: compressed.byteLength };
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

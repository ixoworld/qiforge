import { MatrixManager } from '@ixo/matrix';
import { getMatrixHomeServerCroppedForDid } from '@ixo/oracles-chain-client';
import { Logger, NotFoundException } from '@nestjs/common';
import { Readable } from 'node:stream';
import { getBaseEnvConfig } from '../../config/base-env-config.js';
import type {
  CheckpointBackupStore,
  CheckpointDownloadResult,
  CheckpointUploadParams,
  CheckpointUploadResult,
} from './checkpoint-backup-store.js';
import {
  deleteMediaFromRoom,
  getMediaFromRoom,
  getMediaFromRoomByStorageKey,
  type MatrixMediaEvent,
  uploadMediaToRoom,
} from './matrix-upload-utils.js';

const config = getBaseEnvConfig();

async function collect(readable: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Checkpoint backups as encrypted media in the user's Matrix room (the original store). */
export class MatrixCheckpointStore implements CheckpointBackupStore {
  readonly kind = 'matrix' as const;

  /** Optional cached media event (from file_events) to download without a room lookup. */
  constructor(
    private readonly cachedEventFor: (
      storageKey: string,
    ) => MatrixMediaEvent | undefined,
  ) {}

  async available(): Promise<boolean> {
    return MatrixManager.getInstance().getClient() !== undefined;
  }

  private async lookupRoomId(userDid: string): Promise<string | undefined> {
    const userHomeServer = await getMatrixHomeServerCroppedForDid(userDid);
    const { roomId } =
      await MatrixManager.getInstance().getOracleRoomIdWithHomeServer({
        userDid,
        oracleEntityDid: config.getOrThrow('ORACLE_ENTITY_DID'),
        userHomeServer,
      });
    return roomId;
  }

  private async roomIdFor(userDid: string): Promise<string> {
    const roomId = await this.lookupRoomId(userDid);
    if (!roomId)
      throw new NotFoundException('Room not found or Invalid Session Id');
    return roomId;
  }

  /**
   * Like `roomIdFor`, but resolves to `undefined` instead of throwing when
   * the user has no Matrix room — for `delete`, where "nothing to delete" is
   * a valid, non-exceptional outcome rather than a failure.
   */
  private async tryRoomIdFor(userDid: string): Promise<string | undefined> {
    const roomId = await this.lookupRoomId(userDid);
    if (!roomId) {
      Logger.warn(
        `No Matrix room found for user ${userDid}, cannot delete storage`,
      );
    }
    return roomId;
  }

  async upload(
    params: CheckpointUploadParams,
  ): Promise<CheckpointUploadResult> {
    const bytes = await collect(params.openStream());
    const roomId = await this.roomIdFor(params.userDid);
    Logger.debug(
      `Uploading compressed checkpoint to Matrix room ${roomId} for user ${params.userDid}`,
    );
    const event = await uploadMediaToRoom(
      roomId,
      {
        bytes,
        filename: `${params.storageKey}.db.gz`,
        mimetype: 'application/x-sqlite3',
      },
      params.storageKey,
    );
    return { pointer: event.eventId, event: event.event };
  }

  async download(params: {
    userDid: string;
    storageKey: string;
  }): Promise<CheckpointDownloadResult | null> {
    const cached = this.cachedEventFor(params.storageKey);
    const result = cached
      ? await getMediaFromRoom(undefined, undefined, cached)
      : await getMediaFromRoomByStorageKey(
          await this.roomIdFor(params.userDid),
          params.storageKey,
        );
    if (!result) return null;
    return {
      stream: Readable.from(result.mediaBuffer),
      sizeBytes: result.mediaBuffer.length,
    };
  }

  async delete(params: {
    userDid: string;
    storageKey: string;
  }): Promise<boolean> {
    const roomId = await this.tryRoomIdFor(params.userDid);
    if (!roomId) return false;
    return deleteMediaFromRoom(roomId, params.storageKey);
  }
}

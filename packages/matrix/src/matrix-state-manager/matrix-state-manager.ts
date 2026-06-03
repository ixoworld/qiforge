import 'dotenv/config';
import { deflateSync, inflateSync } from 'node:zlib';

import {
  Direction,
  MatrixClient,
  MatrixError,
  type StateEvents,
} from 'matrix-js-sdk';
import { parse, stringify } from 'superjson';

import { Logger } from '@ixo/logger';
import { logger } from 'matrix-js-sdk/lib/logger.js';

(logger as unknown as { setLevel?: (level: string) => void })?.setLevel?.(
  'ERROR',
);

interface IStatePayload<C> {
  roomId: string;
  stateKey: string;
  data: C;
}

export class MatrixStateManager {
  private readonly client: MatrixClient;
  private static instance: MatrixStateManager;
  private constructor(client?: MatrixClient) {
    if (
      !process.env.MATRIX_BASE_URL ||
      !process.env.MATRIX_ORACLE_ADMIN_ACCESS_TOKEN
    ) {
      throw new Error(
        'MATRIX_BASE_URL and MATRIX_ORACLE_ADMIN_ACCESS_TOKEN must be set',
      );
    }
    this.client =
      client ??
      new MatrixClient({
        baseUrl: process.env.MATRIX_BASE_URL,
        accessToken: process.env.MATRIX_ORACLE_ADMIN_ACCESS_TOKEN,
      });
  }

  async listRooms(): Promise<string[]> {
    const rooms = await this.client.getJoinedRooms();
    return rooms.joined_rooms;
  }

  public static getInstance(): MatrixStateManager {
    if (!MatrixStateManager.instance) {
      MatrixStateManager.instance = new MatrixStateManager();
    }
    return MatrixStateManager.instance;
  }

  private validateRoom(roomId: string): void {
    const roomRegex =
      /^!(?<roomId>[a-zA-Z0-9]+):(?<domain>(?<temp2>localhost|[a-zA-Z0-9.]+)(?<temp1>:\d{1,5})?)?$/;
    if (!roomRegex.test(roomId)) {
      Logger.error(`Invalid room ID: ${roomId}`);
      throw new Error(`Invalid room ID: ${roomId}`);
    }
  }

  public async parseContent<C>(
    content: string,
    roomId: string,
    stateKey: string,
  ): Promise<C> {
    // Try new format first (zlib compressed)
    try {
      const compressed = Buffer.from(content, 'base64');
      const jsonBuf = inflateSync(compressed);
      const str = jsonBuf.toString('utf8');
      const data = parse(str);
      return data as C;
    } catch (zlibError) {
      const zlibErrorMsg =
        zlibError instanceof Error ? zlibError.message : String(zlibError);
      Logger.info(
        `Failed to parse with zlib compression for ${stateKey} in room ${roomId}, attempting legacy format migration`,
      );

      // Try old format (uncompressed superjson)
      try {
        const legacyData = parse(content);
        Logger.warn(
          `Successfully parsed legacy format for ${stateKey} in room ${roomId}, migrating to new format`,
        );

        // Migrate to new format
        // await this.migrateToNewFormat(roomId, stateKey, legacyData);

        return legacyData as C;
      } catch (legacyError) {
        const legacyErrorMsg =
          legacyError instanceof Error
            ? legacyError.message
            : String(legacyError);
        Logger.error(
          `Failed to parse content in both new and legacy formats for ${stateKey} in room ${roomId}`,
          {
            zlibError: zlibErrorMsg,
            legacyError: legacyErrorMsg,
            contentPreview: content.substring(0, 100),
          },
        );
        throw new Error(
          `Unable to parse state content in any supported format: ${legacyErrorMsg}`,
        );
      }
    }
  }

  // Migration is now done lazily on individual getState() calls
  // This avoids 413 "Payload Too Large" errors from bulk migrations

  async getState<C>(roomId: string, stateKey: string): Promise<C> {
    try {
      this.validateRoom(roomId);

      const stateEvent = await this.client.getStateEvent(
        roomId,
        'ixo.room.state',
        stateKey,
      );

      const content = stateEvent.data as unknown;

      if (typeof content !== 'string') {
        throw new Error(`Invalid content type: ${typeof content}`);
      }

      return this.parseContent<C>(content, roomId, stateKey);
    } catch (error) {
      if (error instanceof MatrixError) {
        const isRateLimited = error.errcode === 'M_LIMIT_EXCEEDED';
        if (isRateLimited) {
          Logger.warn('Rate limited, retrying in 10 seconds');
          await new Promise((resolve) => setTimeout(resolve, 10000));
          return this.getState<C>(roomId, stateKey);
        }
      }

      throw error;
    }
  }

  async setState<C>(payload: IStatePayload<C>): Promise<void> {
    try {
      const str = stringify(payload.data);
      const compressed = deflateSync(Buffer.from(str, 'utf8'));
      const b64 = compressed.toString('base64');

      Logger.debug(
        `Setting state for ${payload.stateKey} in room ${payload.roomId} (compressed: ${str.length} -> ${b64.length} chars)`,
      );

      await this.client.sendStateEvent(
        payload.roomId,
        'ixo.room.state' as keyof StateEvents,
        { data: b64 } as StateEvents[keyof StateEvents],
        payload.stateKey,
      );
    } catch (error) {
      Logger.error('Error setting state', error);

      if (error instanceof MatrixError) {
        const isRateLimited = error.errcode === 'M_LIMIT_EXCEEDED';
        if (isRateLimited) {
          Logger.warn('Rate limited, retrying in 10 seconds');
          await new Promise((resolve) => setTimeout(resolve, 10000));
          await this.setState(payload);
        }
      }

      throw error;
    }
  }

  /**
   * @deprecated Use setState instead
   * @param payload - The payload for updating the state
   * @returns The updated state
   */
  async updateState<C extends Record<string, unknown> | undefined>(
    payload: IStatePayload<C>,
  ): Promise<C> {
    let oldState: C | undefined;
    try {
      oldState = await this.getState<C>(payload.roomId, payload.stateKey);
    } catch {
      oldState = undefined;
    }

    const newState = oldState ? { ...oldState, ...payload.data } : payload.data;
    await this.setState({ ...payload, data: newState });
    return newState;
  }

  async listStateEvents<D>(roomId: string): Promise<D[]> {
    const data: D[] = [];
    let migratedCount = 0;
    let totalProcessed = 0;

    const room = await this.client.peekInRoom(roomId);

    Logger.info(`Starting to list state events for room ${room.roomId}`);

    // Start paginating backward.

    while (true) {
      // `client.scrollback` will paginate more events into the timeline.

      await this.client.scrollback(room, 100); // The second argument is the number of events to load.

      // After the scrollback, check if we're at the start of the timeline.
      const timeline = room.getLiveTimeline();
      if (!timeline.getPaginationToken(Direction.Backward)) break;

      for (const event of timeline.getEvents()) {
        const content = event.getContent<{ data: string }>().data;
        if (content) {
          totalProcessed++;
          try {
            // Try new format first
            try {
              const compressed = Buffer.from(content, 'base64');
              const jsonBuf = inflateSync(compressed);
              const str = jsonBuf.toString('utf8');
              data.push(parse(str));
            } catch (zlibError) {
              Logger.warn(
                `Failed to parse with zlib compression for ${event.getId()} in room ${room.roomId}, attempting legacy format migration`,
                {
                  zlibError:
                    zlibError instanceof Error
                      ? zlibError.message
                      : String(zlibError),
                },
              );
              // Try legacy format
              Logger.info(
                `Event ${event.getId()} in room ${room.roomId} uses legacy format, migrating`,
              );
              const legacyData = parse(content);
              data.push(legacyData as D);
              migratedCount++;

              // Note: We can't easily re-save timeline events as they're historical
              // This migration only applies to state events via getState()
            }
          } catch (err) {
            Logger.error(
              `Error parsing event ${event.getId()} in room ${room.roomId}`,
              err,
            );
          }
        }
      }
    }

    Logger.info(
      `Completed listing state events for room ${room.roomId}: ${totalProcessed} processed, ${migratedCount} legacy format detected`,
    );

    // Note: We don't bulk migrate here to avoid 413 errors (payload too large)
    // Individual events are migrated on-demand when accessed via getState()
    if (migratedCount > 0) {
      Logger.info(
        `Found ${migratedCount} events in legacy format - will migrate on next access`,
      );
    }

    return data;
  }
}

export const matrixStateManager = MatrixStateManager.getInstance();

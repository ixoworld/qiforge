import { type MatrixEvent, MatrixManager } from '@ixo/matrix';
import { Logger } from '@nestjs/common';
import { type File } from 'node:buffer';

const logger = new Logger('MatrixUploadUtils');

const getClient = () => {
  const client = MatrixManager.getInstance().getClient();
  if (!client) {
    throw new Error('Matrix client not found');
  }
  return client;
};

const EVENTS = {
  MEDIA_STATE: 'm.ixo.media_state',
  MEDIA_UPLOAD: 'm.ixo.media_upload',
  MEDIA: 'm.ixo.media',
} as const;

export type MatrixMediaEvent = MatrixEvent<{
  msgtype: 'm.file';
  body: string;
  filename: string;
  cid: string;
  sender: string;
  info: {
    mimetype: string;
    size: number;
  };
  file: {
    url: string;
    mimetype: string;
    size: number;
  };
}>;

/**
 * Uploads media to a Matrix room
 * @param roomId The room ID to upload the media to
 * @param file The file to upload
 * @returns Object containing the event ID and CID of the uploaded media
 */
export async function uploadMediaToRoom(
  roomId: string,
  file: File, // This is the sqlite file it's .db file
  storageKey: string,
): Promise<{ eventId: string; storageKey: string; event: MatrixMediaEvent }> {
  const client = getClient();

  logger.debug(
    `Uploading media to room ${roomId} with storageKey ${storageKey}, file size: ${file.size} bytes`,
  );

  // Look up the old media event ID (if any) so we can redact it AFTER the new upload succeeds.
  // This avoids data loss if the upload fails — the old checkpoint stays intact until replaced.
  let oldEventId: string | undefined;
  try {
    const existingMedia = await client.mxClient.getRoomStateEvent(
      roomId,
      EVENTS.MEDIA_STATE,
      storageKey,
    );
    if (existingMedia && existingMedia.eventId) {
      oldEventId = existingMedia.eventId;
      logger.debug(
        `Found existing media event ${oldEventId} for storageKey ${storageKey}, will redact after successful upload`,
      );
    }
  } catch (_error) {
    // State event doesn't exist, proceed with upload
    logger.debug(
      `No existing media state event found for storageKey ${storageKey}, proceeding with new upload`,
    );
  }

  // Check if room is encrypted and upload media
  const isRoomEncrypted = await client.mxClient.crypto.isRoomEncrypted(roomId);

  logger.debug(
    `Room ${roomId} is ${isRoomEncrypted ? 'encrypted' : 'unencrypted'}, proceeding with ${isRoomEncrypted ? 'encrypted' : 'unencrypted'} upload`,
  );

  let event: MatrixMediaEvent;
  let eventId: string;
  if (isRoomEncrypted) {
    // For encrypted rooms
    logger.debug(`Encrypting media for storageKey ${storageKey}`);
    const encrypted = await client.mxClient.crypto.encryptMedia(
      Buffer.from(await file.arrayBuffer()),
    );
    logger.debug(`Uploading encrypted content for storageKey ${storageKey}`);
    const mxc = await client.mxClient.uploadContent(encrypted.buffer);
    eventId = await client.mxClient.sendEvent(roomId, EVENTS.MEDIA_UPLOAD, {
      msgtype: 'm.file',
      body: storageKey,
      filename: storageKey,
      cid: storageKey,
      sender: client.mxClient.getUserId(),
      info: {
        mimetype: 'application/x-sqlite3',
        size: file.size,
      },
      file: {
        url: mxc,
        ...encrypted.file,
      },
    });

    logger.debug(
      `Media event created with eventId ${eventId} for storageKey ${storageKey}`,
    );
    event = await client.mxClient.getEvent(roomId, eventId);
  } else {
    // For unencrypted rooms
    logger.debug(`Uploading unencrypted content for storageKey ${storageKey}`);
    const mxc = await client.mxClient.uploadContent(
      Buffer.from(await file.arrayBuffer()),
    );
    eventId = await client.mxClient.sendEvent(roomId, EVENTS.MEDIA_UPLOAD, {
      msgtype: 'm.file',
      body: storageKey,
      filename: storageKey,
      cid: storageKey,
      sender: client.mxClient.getUserId(),
      info: {
        mimetype: 'application/x-sqlite3',
        size: file.size,
      },
      url: mxc,
    });
    logger.debug(
      `Media event created with eventId ${eventId} for storageKey ${storageKey}`,
    );
    event = await client.mxClient.getEvent(roomId, eventId);
  }

  // Save the media event ID in the room state with storageKey as the key
  logger.debug(
    `Saving media state event for storageKey ${storageKey} with eventId ${eventId}`,
  );
  await client.mxClient.sendStateEvent(roomId, EVENTS.MEDIA_STATE, storageKey, {
    eventId,
  });

  // Now that the new upload is live and the state pointer is updated,
  // redact the old media event to reclaim storage. This is safe — if
  // redaction fails, we just have a dangling old blob (no data loss).
  if (oldEventId) {
    try {
      await client.mxClient.redactEvent(
        roomId,
        oldEventId,
        'Replacing with updated file',
      );
      logger.debug(`Successfully redacted old media event ${oldEventId}`);
    } catch (redactError) {
      logger.warn(
        `Failed to redact old media event ${oldEventId}:`,
        redactError,
      );
    }
  }

  logger.debug(
    `Successfully uploaded media to room ${roomId} with storageKey ${storageKey}, eventId: ${eventId}`,
  );

  return { eventId, storageKey, event };
}

export interface GetMediaFromRoomByStorageKeyResult {
  mediaBuffer: Buffer;
  contentInfo: {
    mimetype: string;
    filename: string;
    storageKey: string;
  };
}

/**
 * Gets media from a Matrix room by CID
 * @param roomId The room ID
 * @param storageKey The storage key of the media
 * @returns Object containing the media buffer and content info
 */
export async function getMediaFromRoomByStorageKey(
  roomId: string,
  storageKey: string,
): Promise<GetMediaFromRoomByStorageKeyResult | null> {
  const client = getClient();
  // Get the event ID from room state
  try {
    logger.debug(
      `Attempting to retrieve media from room ${roomId} with storageKey ${storageKey}`,
    );
    const stateEvent = await client.mxClient.getRoomStateEvent(
      roomId,
      EVENTS.MEDIA_STATE,
      storageKey,
    );
    if (!stateEvent || !stateEvent.eventId) {
      logger.warn(
        `No media state event found with storageKey: ${storageKey} in room ${roomId}`,
      );
      return null;
    }

    logger.debug(
      `Found media state event with eventId: ${stateEvent.eventId} for storageKey: ${storageKey}`,
    );

    // Get the media using the event ID
    const result = await getMediaFromRoom(roomId, stateEvent.eventId);

    logger.debug(
      `Successfully retrieved media for storageKey: ${storageKey}, size: ${result.mediaBuffer.length} bytes`,
    );

    // Add CID to content info
    return {
      mediaBuffer: result.mediaBuffer,
      contentInfo: {
        ...result.contentInfo,
        storageKey,
      },
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    // Check if it's an M_NOT_FOUND error and ignore it
    if (
      errorMessage.includes('M_NOT_FOUND') ||
      errorMessage.includes('Event not found')
    ) {
      logger.debug(
        `Media not found in Matrix for storageKey ${storageKey} (M_NOT_FOUND), this is expected for new checkpoints`,
      );
      return null;
    }
    // For other errors, log and rethrow
    logger.error(
      `Error retrieving media with storageKey ${storageKey}: ${errorMessage}`,
      error instanceof Error ? error.stack : undefined,
    );

    throw new Error(
      `Error retrieving media with storageKey ${storageKey}: ${errorMessage}`,
    );
  }
}

/**
 * Retrieves media from a Matrix room
 * @param roomId The room ID where the media is located
 * @param eventId The event ID of the media
 * @returns Object containing the media buffer and content info
 */

export async function getMediaFromRoom(
  roomId?: string,
  eventId?: string,
  cachedEvent?: MatrixMediaEvent,
): Promise<{
  mediaBuffer: Buffer;
  contentInfo: {
    mimetype: string;
    filename: string;
  };
}> {
  if ((!roomId || !eventId) && !cachedEvent) {
    throw new Error(
      'Either roomId and eventId or cachedEvent must be provided',
    );
  }
  const client = getClient();
  const event =
    cachedEvent || (await client.mxClient.getEvent(roomId!, eventId!));

  if (
    !event.content ||
    !['m.file', 'm.image'].includes(event.content.msgtype)
  ) {
    throw new Error('Event is not a media event.');
  }

  const isEncrypted = !!event.content.file;

  if (isEncrypted) {
    const decryptedData = await client.mxClient.crypto.decryptMedia(
      event.content.file,
    );
    return {
      mediaBuffer: decryptedData,
      contentInfo: {
        mimetype: event.content.info?.mimetype || 'application/octet-stream',
        filename: event.content.filename || 'download',
      },
    };
  } else {
    const mediaBuffer = await client.mxClient.downloadContent(
      event.content.url,
    );
    return {
      mediaBuffer: mediaBuffer.data,
      contentInfo: {
        mimetype: event.content.info?.mimetype || 'application/octet-stream',
        filename: event.content.filename || 'download',
      },
    };
  }
}

/**
 * Deletes media from a Matrix room by storage key
 * @param roomId The room ID where the media is located
 * @param storageKey The storage key of the media to delete
 * @returns True if deletion was successful, false if not found
 */
export async function deleteMediaFromRoom(
  roomId: string,
  storageKey: string,
): Promise<boolean> {
  const client = getClient();

  try {
    logger.debug(
      `Attempting to delete media from room ${roomId} with storageKey ${storageKey}`,
    );

    // Get the event ID from room state
    const stateEvent = await client.mxClient.getRoomStateEvent(
      roomId,
      EVENTS.MEDIA_STATE,
      storageKey,
    );

    if (!stateEvent || !stateEvent.eventId) {
      logger.warn(
        `No media state event found with storageKey: ${storageKey} in room ${roomId}`,
      );
      return false;
    }

    logger.debug(
      `Found media event ${stateEvent.eventId} for storageKey ${storageKey}, attempting to redact`,
    );

    // Redact the media event to delete the DB file from the server
    try {
      await client.mxClient.redactEvent(
        roomId,
        stateEvent.eventId,
        'User requested deletion',
      );
      logger.debug(
        `Successfully redacted media event ${stateEvent.eventId} for storageKey ${storageKey}`,
      );
    } catch (redactError) {
      logger.error(
        `Failed to redact media event ${stateEvent.eventId}:`,
        redactError,
      );
      throw redactError;
    }

    return true;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';

    // Check if it's an M_NOT_FOUND error
    if (
      errorMessage.includes('M_NOT_FOUND') ||
      errorMessage.includes('Event not found')
    ) {
      logger.debug(
        `Media not found in Matrix for storageKey ${storageKey} (M_NOT_FOUND)`,
      );
      return false;
    }

    // For other errors, log and rethrow
    logger.error(
      `Error deleting media with storageKey ${storageKey}: ${errorMessage}`,
      error instanceof Error ? error.stack : undefined,
    );
    throw new Error(
      `Error deleting media with storageKey ${storageKey}: ${errorMessage}`,
    );
  }
}

import { MatrixManager } from '@ixo/matrix';
import {
  MEDIA_MSGTYPES,
  uploadMediaContent,
} from './checkpointer/matrix-upload-utils.js';

/** How far back a thread-attachment listing scans the room timeline. */
const ATTACHMENT_SCAN_LIMIT = 200;

/** A file handed to the user in a room, optionally inside a thread. */
export interface RoomFileSend {
  roomId: string;
  fileName: string;
  mediaType: string;
  bytes: Buffer;
  /** Thread root event id — posts the file inside that thread when set. */
  threadId?: string;
}

/**
 * Send a file into a Matrix room as a native `m.file` message, uploading the
 * bytes through the shared media lane (so an encrypted room gets an encrypted
 * attachment). Returns the new timeline event id.
 */
export async function sendFileToRoom(input: RoomFileSend): Promise<string> {
  const { roomId, fileName, mediaType, bytes, threadId } = input;
  const source = await uploadMediaContent(roomId, bytes);

  return MatrixManager.getInstance().sendMatrixEvent(roomId, 'm.room.message', {
    msgtype: 'm.file',
    body: fileName,
    filename: fileName,
    info: { mimetype: mediaType, size: bytes.length },
    ...source,
    ...(threadId
      ? {
          'm.relates_to': {
            event_id: threadId,
            is_falling_back: true,
            'm.in_reply_to': { event_id: threadId },
            rel_type: 'm.thread',
          },
        }
      : {}),
  });
}

/** One attachment previously shared in a thread. */
export interface ThreadAttachment {
  eventId: string;
  /** The event's `body` — the original file name for media messages. */
  fileName: string;
  msgtype: string;
  sender: string;
  /** Origin server timestamp (ms). */
  timestamp: number;
}

/** One timeline entry as the room-message reader surfaces it. */
export interface TimelineMessage {
  eventId: string;
  sender: string;
  body: string;
  timestamp: number;
  threadId?: string;
  msgtype?: string;
}

/**
 * Keep only the media messages belonging to one thread — either related to
 * `threadId` or the thread root itself. This is the whole scoping rule: an
 * attachment from elsewhere in the room is never surfaced.
 */
export function filterThreadAttachments(
  messages: readonly TimelineMessage[],
  threadId: string,
): ThreadAttachment[] {
  return messages
    .filter(
      (m) =>
        m.msgtype !== undefined &&
        MEDIA_MSGTYPES.includes(m.msgtype) &&
        (m.threadId === threadId || m.eventId === threadId),
    )
    .map((m) => ({
      eventId: m.eventId,
      fileName: m.body,
      msgtype: m.msgtype ?? 'm.file',
      sender: m.sender,
      timestamp: m.timestamp,
    }));
}

/**
 * List the media messages shared inside one thread, newest last. Scans the
 * recent room timeline and keeps only what belongs to the thread — never a
 * general room-history browser.
 */
export async function listThreadAttachments(
  roomId: string,
  threadId: string,
  limit: number = ATTACHMENT_SCAN_LIMIT,
): Promise<ThreadAttachment[]> {
  const { messages } = await MatrixManager.getInstance().getRecentRoomMessages(
    roomId,
    { limit },
  );
  return filterThreadAttachments(messages, threadId);
}

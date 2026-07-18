/**
 * Encrypted-media envelope for an `m.file` event: the mxc URI plus the
 * encryption fields returned by matrix-bot-sdk's `crypto.encryptMedia`
 * (`key`, `iv`, `hashes`, `v`). Clients need the whole envelope to decrypt.
 */
export type EncryptedFileEnvelope = { url: string } & Record<string, unknown>;

export interface BuildFileMessageContentInput {
  filename: string;
  mimetype: string;
  /** Unencrypted payload size in bytes (shown by clients in the file card). */
  size: number;
  /** Fallback text shown by clients that can't render files. Defaults to the filename. */
  body?: string;
  /** Thread root event ID — attaches the file to the thread like text sends. */
  threadId?: string;
  /** Plain-room mxc URI. Exactly one of `url` / `encryptedFile` must be set. */
  url?: string;
  /** Encrypted-room envelope (mxc URI + `crypto.encryptMedia().file` fields). */
  encryptedFile?: EncryptedFileEnvelope;
}

/**
 * Build the content object for a standard `m.room.message` file event
 * (`msgtype: 'm.file'`) — the same shape the runtime's Matrix listener
 * already parses on the inbound path, so files the oracle posts look
 * identical to files users upload.
 */
export function buildFileMessageContent(
  input: BuildFileMessageContentInput,
): Record<string, unknown> {
  const { filename, mimetype, size, body, threadId, url, encryptedFile } =
    input;

  if ((url === undefined) === (encryptedFile === undefined)) {
    throw new Error(
      'buildFileMessageContent requires exactly one of `url` (plain room) or `encryptedFile` (encrypted room)',
    );
  }

  return {
    msgtype: 'm.file',
    body: body ?? filename,
    filename,
    info: {
      mimetype,
      size,
    },
    'm.mentions': {},
    ...(threadId
      ? {
          'm.relates_to': {
            event_id: threadId,
            is_falling_back: true,
            'm.in_reply_to': {
              event_id: threadId,
            },
            rel_type: 'm.thread',
          },
        }
      : {}),
    ...(encryptedFile ? { file: encryptedFile } : { url }),
  };
}

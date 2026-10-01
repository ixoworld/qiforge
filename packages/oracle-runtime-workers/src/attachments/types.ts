/**
 * Wire shape of a chat attachment — the Node runtime's `AttachmentDto`
 * (`POST /messages/:sessionId` body `attachments[]`, also what
 * `@ixo/oracles-client-sdk` sends): either an `mxcUri` (`mxc://…` or an
 * `http(s)://` URL) or a Matrix `eventId` (encrypted uploads), plus the
 * filename / mimetype / size the client knows.
 */

export interface AttachmentInput {
  /** `mxc://server/id` or `http(s)://…`. Required when `eventId` is absent. */
  mxcUri?: string;
  /** Matrix event id (`$…`) — encrypted media is fetched and decrypted via the event. */
  eventId?: string;
  filename: string;
  mimetype: string;
  size?: number;
}

/** Same cap as the Node DTO (`@ArrayMaxSize`). */
export const MAX_ATTACHMENTS = 10;

const URI_RE = /^(mxc|https?):\/\/.+/i;
const EVENT_ID_RE = /^\$/;
const MAX_FILENAME = 255;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate the request's `attachments` the way the Node DTO does. Throws an
 * `Error` whose message names the offending entry — callers surface it as
 * the turn's error (Node answers 400 at the controller).
 */
export function parseAttachmentInputs(value: unknown): AttachmentInput[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('attachments must be an array');
  if (value.length > MAX_ATTACHMENTS)
    throw new Error(`attachments: at most ${MAX_ATTACHMENTS} per message`);
  return value.map((entry, i) => {
    if (!isRecord(entry)) throw new Error(`attachments[${i}]: not an object`);
    const mxcUri = entry['mxcUri'];
    const eventId = entry['eventId'];
    const filename = entry['filename'];
    const mimetype = entry['mimetype'];
    const size = entry['size'];
    if (
      mxcUri !== undefined &&
      (typeof mxcUri !== 'string' || !URI_RE.test(mxcUri))
    )
      throw new Error(
        `attachments[${i}].mxcUri must start with mxc://, http://, or https://`,
      );
    if (
      eventId !== undefined &&
      (typeof eventId !== 'string' || !EVENT_ID_RE.test(eventId))
    )
      throw new Error(`attachments[${i}].eventId must start with $`);
    if (!mxcUri && !eventId)
      throw new Error(
        `attachments[${i}]: either mxcUri or eventId must be provided`,
      );
    if (
      typeof filename !== 'string' ||
      filename.length === 0 ||
      filename.length > MAX_FILENAME
    )
      throw new Error(
        `attachments[${i}].filename is required (≤ ${MAX_FILENAME} chars)`,
      );
    if (typeof mimetype !== 'string' || mimetype.length === 0)
      throw new Error(`attachments[${i}].mimetype is required`);
    if (
      size !== undefined &&
      (typeof size !== 'number' || !Number.isFinite(size) || size < 0)
    )
      throw new Error(`attachments[${i}].size must be a non-negative number`);
    return {
      ...(typeof mxcUri === 'string' ? { mxcUri } : {}),
      ...(typeof eventId === 'string' ? { eventId } : {}),
      filename,
      mimetype,
      ...(typeof size === 'number' ? { size } : {}),
    };
  });
}

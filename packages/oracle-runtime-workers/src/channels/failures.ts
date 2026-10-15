/**
 * Failures on the channel path that retrying cannot fix. Everything else a
 * channel turn throws stays a `503 unavailable` the gateway retries with
 * backoff; these two are answered as final refusals instead, so the gateway
 * sends its failure reply at once rather than after hours of retries.
 *
 * Errors cross Durable Object RPC as a plain `Error` carrying only its
 * message (the class, `name` and custom fields are gone on the caller's
 * side), so both are recognised by what survives: the owner-copy failure's
 * JSON envelope (`parseOwnerCopyFailure`) and matrix-js-sdk's
 * `MatrixError: [<status>] …` message wording.
 */
import { parseOwnerCopyFailure } from '../owner-store/owner-copy-errors';
import { ChannelError } from './contract';

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The homeserver refused the oracle in the user's room: the bot was kicked
 * or left (`M_FORBIDDEN`, HTTP 403), or the SDK knows the room as one the
 * bot has not joined.
 */
export function isRoomForbidden(error: unknown): boolean {
  if (
    error instanceof Error &&
    (error.name === 'M_FORBIDDEN' ||
      ('errcode' in error && error.errcode === 'M_FORBIDDEN'))
  )
    return true;
  const message = errorMessage(error);
  return (
    /\bM_FORBIDDEN\b/.test(message) ||
    /MatrixError: \[403\]/.test(message) ||
    /is not a joined room known to the bot/.test(message) ||
    /\bnot (in|a member of) (the |this )?room\b/i.test(message)
  );
}

/**
 * The final refusal for a failure retrying cannot fix, or null when the
 * failure stays a transient `503 unavailable`:
 *
 * - the user's oracle room refused the oracle → `409 room_unavailable`;
 * - the user's file storage rejected the oracle's credentials while the
 *   owner copy loaded (`VFS_AUTH_FAILED`; `NO_VFS_DELEGATION` is a
 *   `428 delegation_required` and is handled before this) →
 *   `403 storage_unauthorized`.
 */
export function classifyChannelFailure(error: unknown): ChannelError | null {
  if (parseOwnerCopyFailure(error)?.code === 'VFS_AUTH_FAILED')
    return new ChannelError(
      403,
      "The user's file storage rejected the oracle; the oracle cannot load the user's data",
      'storage_unauthorized',
    );
  if (isRoomForbidden(error))
    return new ChannelError(
      409,
      "The oracle cannot use the user's oracle room (it is not a member or was refused)",
      'room_unavailable',
    );
  return null;
}

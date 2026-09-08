/**
 * Why a user's owner copy could not be loaded on a cold boot, classified so
 * the object retries only what can succeed on its own and the shell can
 * answer with an honest status code:
 *
 *   - `NO_VFS_DELEGATION` (403, not retryable): the user's delegation to this
 *     oracle (or the lack of one) grants no `ixo:filesystem` capability over
 *     `/.oracles`. Retrying cannot help; the client must authorize the oracle
 *     again with file storage included and try again.
 *   - `VFS_AUTH_FAILED` (403, not retryable): the VFS rejected the oracle's
 *     credentials (401/403). Something is misconfigured; retrying cannot help.
 *   - `OWNER_COPY_UNAVAILABLE` (503, retryable): the VFS was unreachable or
 *     failing (network, 5xx, 429, timeout). The object already retried with
 *     backoff; the next request tries again from scratch.
 *
 * In every case nothing was written — the boot is not memoised on failure.
 */
import { VfsNoDelegationError, VfsRequestError } from './ixo-vfs-store';

export type OwnerCopyErrorCode =
  | 'NO_VFS_DELEGATION'
  | 'VFS_AUTH_FAILED'
  | 'OWNER_COPY_UNAVAILABLE';

/** Backoff between cold-boot load attempts: three retries, ~7 s in total. */
export const OWNER_COPY_LOAD_RETRY_DELAYS_MS: readonly number[] = [
  1_000, 2_000, 4_000,
];

export class OwnerCopyUnavailableError extends Error {
  readonly code: OwnerCopyErrorCode;

  readonly httpStatus: 403 | 503;

  readonly retryable: boolean;

  readonly userDid: string;

  constructor(userDid: string, cause: unknown, attempts: number) {
    const code = classifyOwnerCopyError(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(messageFor(code, detail, attempts));
    this.name = 'OwnerCopyUnavailableError';
    this.code = code;
    this.httpStatus = code === 'OWNER_COPY_UNAVAILABLE' ? 503 : 403;
    this.retryable = code === 'OWNER_COPY_UNAVAILABLE';
    this.userDid = userDid;
  }
}

/** Whether a failed load may succeed if simply tried again shortly. */
export function isRetryableOwnerCopyError(error: unknown): boolean {
  return classifyOwnerCopyError(error) === 'OWNER_COPY_UNAVAILABLE';
}

export function classifyOwnerCopyError(error: unknown): OwnerCopyErrorCode {
  if (error instanceof VfsNoDelegationError) return 'NO_VFS_DELEGATION';
  if (
    error instanceof VfsRequestError &&
    (error.status === 401 || error.status === 403)
  )
    return 'VFS_AUTH_FAILED';
  return 'OWNER_COPY_UNAVAILABLE';
}

function messageFor(
  code: OwnerCopyErrorCode,
  detail: string,
  attempts: number,
): string {
  switch (code) {
    case 'NO_VFS_DELEGATION':
      return `Your oracle data cannot be loaded because your authorization for this oracle does not include file storage (ixo:filesystem over /.oracles). Authorize the oracle again to grant it, then try again. Nothing was changed. (${detail})`;
    case 'VFS_AUTH_FAILED':
      return `Your oracle data cannot be loaded because your file storage rejected the oracle's credentials. Nothing was changed. (${detail})`;
    default:
      return `Your oracle data could not be loaded from your file storage after ${attempts} attempt(s). Nothing was changed — please try again in a moment. (${detail})`;
  }
}

/** What the shell needs to answer a request whose owner copy could not load. */
export interface OwnerCopyFailure {
  code: OwnerCopyErrorCode;
  httpStatus: 403 | 503;
  retryable: boolean;
  message: string;
}

const RPC_ENVELOPE_TAG = 'owner-copy';

interface RpcEnvelope extends OwnerCopyFailure {
  oracleError: typeof RPC_ENVELOPE_TAG;
}

/**
 * Durable Object RPC serialises a thrown error as a plain `Error` carrying
 * only its message: the class, `name` and custom fields are gone on the
 * caller's side. The user object therefore throws the failure as a JSON
 * envelope in the message, and the shell / turn handler read it back with
 * `parseOwnerCopyFailure`. Inside the object `instanceof` still works.
 */
export function toRpcError(failure: OwnerCopyUnavailableError): Error {
  const envelope: RpcEnvelope = {
    oracleError: RPC_ENVELOPE_TAG,
    code: failure.code,
    httpStatus: failure.httpStatus,
    retryable: failure.retryable,
    message: failure.message,
  };
  const err = new Error(JSON.stringify(envelope));
  err.name = failure.name;
  return err;
}

function isEnvelope(value: unknown): value is RpcEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { oracleError?: unknown }).oracleError === RPC_ENVELOPE_TAG &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}

/**
 * Recover the typed failure from anything the object may have thrown: the
 * class itself (same isolate), its RPC envelope (across the stub), or the
 * raw store errors when they escape before classification. `null` for
 * everything else (a genuine 500).
 */
export function parseOwnerCopyFailure(error: unknown): OwnerCopyFailure | null {
  if (error instanceof OwnerCopyUnavailableError) {
    return {
      code: error.code,
      httpStatus: error.httpStatus,
      retryable: error.retryable,
      message: error.message,
    };
  }
  if (!(error instanceof Error)) return null;
  if (error.message.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(error.message);
      if (isEnvelope(parsed)) {
        const { code, httpStatus, retryable, message } = parsed;
        return { code, httpStatus, retryable, message };
      }
    } catch {
      // not an envelope
    }
  }
  if (error.name === 'VfsNoDelegationError') {
    return {
      code: 'NO_VFS_DELEGATION',
      httpStatus: 403,
      retryable: false,
      message: error.message,
    };
  }
  return null;
}

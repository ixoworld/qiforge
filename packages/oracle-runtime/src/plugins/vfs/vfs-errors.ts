/**
 * VFS error contract.
 *
 * Every transport failure is mapped to one of two typed errors:
 *   - {@link VfsHttpError}  — a non-2xx HTTP response (status + parsed message).
 *   - {@link VfsAuthError}  — a two-hop UCAN auth failure (no delegation, store
 *     unreachable, or mint failed) surfaced before any request leaves.
 *
 * {@link mapVfsError} turns either into a single agent-actionable string; the
 * tools return that string (never a raw stack). The 409 family is
 * disambiguated by message substring because the VFS reuses `409 Conflict`
 * for five distinct situations.
 */

/** Minimum UCAN ability required for a VFS operation. */
export type VfsAbility = 'fs/list' | 'fs/read' | 'fs/write' | 'fs/delete';

/** Why the two-hop auth resolution failed. */
export type VfsAuthErrorKind = 'no-delegation' | 'store-error' | 'mint-failed';

/**
 * Step-by-step guidance shown when the user hasn't granted the oracle
 * filesystem access. Walks them through the portal's Manage-access flow
 * (domain → Library → Files → Access). When the oracle's own DID is known it is
 * appended so the user can paste it straight into the "Recipient DID" field.
 */
export function noAccessMessage(oracleDid?: string): string {
  const steps =
    "I don't have access to your files yet. To grant me access, in the portal: open your domain → **Library** → **Files**, click **Access** (top-right), then in **Manage access** paste my agent DID as the Recipient DID, choose the rights (Read / Write / Delete), set the scope and how long it lasts, and click **Grant access**. It's delivered to my inbox and I pick it up automatically — then ask me again.";
  return oracleDid ? `${steps}\n\nMy agent DID: ${oracleDid}` : steps;
}

/** The no-access guidance with no DID (back-compat + barrel export). */
export const NO_ACCESS_MESSAGE = noAccessMessage();

/** A non-2xx response from the VFS, with the parsed message + raw body. */
export class VfsHttpError extends Error {
  readonly status: number;

  readonly raw: string;

  readonly code?: string;

  constructor(params: {
    status: number;
    message: string;
    raw: string;
    code?: string;
  }) {
    super(params.message);
    this.name = 'VfsHttpError';
    this.status = params.status;
    this.raw = params.raw;
    if (params.code !== undefined) this.code = params.code;
  }
}

/** A UCAN auth failure raised before (or instead of) an HTTP round-trip. */
export class VfsAuthError extends Error {
  readonly kind: VfsAuthErrorKind;

  readonly detail?: string;

  constructor(kind: VfsAuthErrorKind, detail?: string) {
    super(detail && detail.length > 0 ? detail : kind);
    this.name = 'VfsAuthError';
    this.kind = kind;
    if (detail !== undefined) this.detail = detail;
  }
}

/** Lowercased `<message> <raw>` used for substring classification. */
function haystack(err: VfsHttpError): string {
  return `${err.message} ${err.raw}`.toLowerCase();
}

/**
 * `true` when the error is a `409` whose body says the file was modified by
 * another writer. This is the one mutation case tools retry once.
 */
export function isWriteConflict(err: unknown): err is VfsHttpError {
  return (
    err instanceof VfsHttpError &&
    err.status === 409 &&
    /modified concurrently/.test(haystack(err))
  );
}

/** `true` when the error is a `409` from creating a file at an existing path. */
export function isAlreadyExistsConflict(err: unknown): err is VfsHttpError {
  return (
    err instanceof VfsHttpError &&
    err.status === 409 &&
    /already exists/.test(haystack(err))
  );
}

/** Agent-facing message for a `409`, disambiguated by the body substring. */
function map409(err: VfsHttpError, path?: string): string {
  const text = haystack(err);
  if (/already exists/.test(text)) {
    return path
      ? `A file already exists at \`${path}\`. Ask the user before overwriting it.`
      : 'A file already exists at that path. Ask the user before overwriting it.';
  }
  if (/oldstring/.test(text)) {
    return `Couldn't apply the edit: ${err.message}. Read the file first and add more surrounding context so the text matches exactly once, or set replaceAll.`;
  }
  if (/destination occupied|duplicate id/.test(text)) {
    return `Couldn't move it — the destination is occupied: ${err.message}.`;
  }
  if (/version limit reached/.test(text)) {
    return 'This file hit its 50-version limit. Delete old versions before saving again, or write the change as a new file.';
  }
  if (/modified concurrently/.test(text)) {
    return 'The file was changed by someone else while I was writing. Please try again.';
  }
  return err.message || 'That change conflicts with the current state of the file.';
}

/**
 * Turn a {@link VfsHttpError} or {@link VfsAuthError} into a single
 * agent-actionable sentence. `ctx.path` enriches the "already exists" message.
 */
export function mapVfsError(
  err: unknown,
  ctx: { path?: string; oracleDid?: string } = {},
): string {
  if (err instanceof VfsAuthError) {
    return err.kind === 'no-delegation'
      ? noAccessMessage(ctx.oracleDid)
      : "Couldn't get filesystem access right now.";
  }

  if (err instanceof VfsHttpError) {
    switch (err.status) {
      case 401:
        return "Couldn't authenticate to your filesystem right now.";
      case 403:
        return `That's outside what you shared with me — it may be read-only, or a different folder than the one you granted. To give me more access, re-grant in the portal: your domain → Library → Files → Access → Manage access.${ctx.oracleDid ? ` My agent DID: ${ctx.oracleDid}.` : ''}`;
      case 404:
        return "No such file, or it's outside the folder you shared.";
      case 409:
        return map409(err, ctx.path);
      case 413:
      case 415:
        return `${err.message || `The file could not be handled (HTTP ${err.status})`} — try a smaller scope, or replace the file instead.`;
      case 429:
        return 'The filesystem is busy right now — please try again in a moment.';
      case 503:
        return 'Filesystem temporarily unavailable.';
      default:
        if (err.status === 0 || err.status >= 500) {
          return 'Filesystem request failed.';
        }
        return err.message || 'Filesystem request failed.';
    }
  }

  return 'Filesystem request failed.';
}

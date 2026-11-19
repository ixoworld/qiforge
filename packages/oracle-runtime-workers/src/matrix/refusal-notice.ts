/**
 * The room notice for a turn a plugin's gate refused (`TurnResult.refused`),
 * and its throttle.
 *
 * The notice is one `m.notice`: `body` is the refusal's message, then the
 * call to action as `label: url` on its own line; `formatted_body` is the
 * message (HTML-escaped) and the action as a link. In a group room it
 * starts with a mention of the refused person (`m.mentions.user_ids`, a
 * matrix.to pill, the display name in `body`), so the others know it is not
 * for them.
 *
 * Throttle: at most one notice per (room, user, code) in
 * `REFUSAL_NOTICE_WINDOW_MS`; a refused message inside the window posts
 * nothing. A turn that is allowed for the user in the room clears the
 * user's entries there. The entries live in the gateway's SQLite
 * (`refusal_notice_throttle`), so a reset does not forget them; an entry
 * older than the window is swept on every claim, so the table holds at most
 * the notices of the last window. The table is created on the first
 * refusal: an oracle whose turns are never refused never writes it.
 */
import type { TurnRefusal } from '../plugin-api/turn-gate';
import { refusalAction } from '../core/turn-gate';
import { escapeHtml } from './reply-parts';

/** One notice per (room, user, code) per this window. */
export const REFUSAL_NOTICE_WINDOW_MS = 10 * 60_000;

const TABLE = 'refusal_notice_throttle';

export interface RefusalNoticeKey {
  roomId: string;
  /** The refused person's Matrix user id. */
  userId: string;
  /** The refusal's `code` (empty when it has none). */
  code: string;
}

/** Whether the throttle table exists (an oracle never refused has none). */
export function hasRefusalNoticeTable(sql: SqlStorage): boolean {
  return (
    sql
      .exec(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
        TABLE,
      )
      .toArray().length > 0
  );
}

export function ensureRefusalNoticeTable(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
      room_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      code TEXT NOT NULL,
      posted_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, user_id, code)
    ) WITHOUT ROWID`,
  );
}

/**
 * Claim the notice for `key` at `now`: true when none was posted in the
 * window (the caller posts it), false when one was (the caller posts
 * nothing). Expired entries are swept first. Synchronous, so two refusals
 * dispatched at once cannot both claim it.
 */
export function claimRefusalNotice(
  sql: SqlStorage,
  key: RefusalNoticeKey,
  now: number,
  windowMs = REFUSAL_NOTICE_WINDOW_MS,
): boolean {
  sql.exec(`DELETE FROM ${TABLE} WHERE posted_at <= ?`, now - windowMs);
  const held =
    sql
      .exec(
        `SELECT 1 FROM ${TABLE} WHERE room_id = ? AND user_id = ? AND code = ?`,
        key.roomId,
        key.userId,
        key.code,
      )
      .toArray().length > 0;
  if (held) return false;
  sql.exec(
    `INSERT INTO ${TABLE} (room_id, user_id, code, posted_at) VALUES (?, ?, ?, ?)`,
    key.roomId,
    key.userId,
    key.code,
    now,
  );
  return true;
}

/** Give a claim back (the notice could not be posted). */
export function releaseRefusalNotice(
  sql: SqlStorage,
  key: RefusalNoticeKey,
): void {
  sql.exec(
    `DELETE FROM ${TABLE} WHERE room_id = ? AND user_id = ? AND code = ?`,
    key.roomId,
    key.userId,
    key.code,
  );
}

/** A turn was allowed for `userId` in `roomId`: forget their notices there. */
export function clearRefusalNotices(
  sql: SqlStorage,
  roomId: string,
  userId: string,
): void {
  sql.exec(
    `DELETE FROM ${TABLE} WHERE room_id = ? AND user_id = ?`,
    roomId,
    userId,
  );
}

/** Who the notice is for, as the gateway knows them when the turn is refused. */
export interface RefusalNoticeTarget {
  roomKind: 'direct' | 'group';
  /** The refused person's Matrix user id. */
  userId: string;
  /** Their display name in the room (the user id when none is known). */
  displayName: string;
}

export interface RefusalNoticeContent {
  body: string;
  formattedBody: string;
  /** Group rooms: the refused person (`m.mentions.user_ids`). */
  mentions?: string[];
}

/** `@alice:example.org` → `alice`. */
function localpart(userId: string): string {
  const colon = userId.indexOf(':');
  return userId.slice(
    userId.startsWith('@') ? 1 : 0,
    colon > 0 ? colon : undefined,
  );
}

/** The matrix.to permalink of a user (percent-encoded, RFC 3986). */
export function matrixToUserLink(userId: string): string {
  return `https://matrix.to/#/${encodeURIComponent(userId)}`;
}

/** The notice's content (see the module comment). */
export function refusalNoticeContent(
  refusal: TurnRefusal,
  target: RefusalNoticeTarget,
): RefusalNoticeContent {
  const action = refusalAction(refusal);
  const message = refusal.message;
  const html = escapeHtml(message).replace(/\r?\n/g, '<br>');
  const actionText = action ? `\n${action.label}: ${action.url}` : '';
  const actionHtml = action
    ? `<br><a href="${escapeHtml(action.url)}">${escapeHtml(action.label)}</a>`
    : '';
  if (target.roomKind !== 'group')
    return {
      body: `${message}${actionText}`,
      formattedBody: `${html}${actionHtml}`,
    };
  const shown = target.displayName.trim();
  const name =
    shown && shown !== target.userId ? shown : localpart(target.userId);
  return {
    body: `${name}: ${message}${actionText}`,
    formattedBody: `<a href="${escapeHtml(matrixToUserLink(target.userId))}">${escapeHtml(name)}</a>: ${html}${actionHtml}`,
    mentions: [target.userId],
  };
}

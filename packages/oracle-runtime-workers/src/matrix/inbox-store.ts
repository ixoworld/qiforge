/**
 * Durable inbox for room messages whose turn is still in flight.
 *
 * The bot SDK marks an inbound event processed before it is delivered, and
 * the reply only reaches the durable outbox once the user object has finished
 * the whole LLM turn. A gateway reset in between — a platform host drain, a
 * deploy — used to lose the reply silently: the fresh instance saw the event
 * as processed and never asked again. Every accepted message is therefore
 * written here before anything waits on the network, deleted once its turn
 * has ended (reply in the outbox, empty reply, superseded, error notice
 * posted), and whatever is left is re-dispatched on the next start. The user
 * object makes re-dispatch safe (`src/do/matrix-turn-ledger.ts`): an event
 * it already answered returns the stored text, one still running attaches,
 * and one interrupted mid-turn is refused — never run twice.
 *
 * Cost shape (SQLite-backed Durable Object storage bills rows written and
 * read): one row written on receipt, one delete when the turn ends.
 */
import type { InboundAttachment, InboundMessage } from './ingest';

export interface InboxRow extends InboundMessage {
  receivedAt: number;
  /** Replays charged to this row (0 = never replayed). */
  attempts: number;
}

/**
 * Replays a message gets after the original dispatch. A row that has been
 * replayed this many times when the next start finds it is given up: the
 * user gets the "try again" notice instead of a fourth attempt.
 */
export const MAX_TURN_REPLAYS = 2;

export function ensureInboxTable(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS turn_inbox (
      event_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      ts INTEGER NOT NULL,
      body TEXT NOT NULL,
      thread_root_id TEXT,
      attachment TEXT,
      received_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID`,
  );
}

/** Record a message before its turn starts. A repeat of the same event id is a no-op. */
export function insertInboxRow(
  sql: SqlStorage,
  msg: InboundMessage,
  receivedAt: number,
): void {
  sql.exec(
    `INSERT OR IGNORE INTO turn_inbox
      (event_id, room_id, sender, ts, body, thread_root_id, attachment, received_at, attempts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    msg.eventId,
    msg.roomId,
    msg.sender,
    msg.ts,
    msg.body,
    msg.threadRootId ?? null,
    msg.attachment ? JSON.stringify(msg.attachment) : null,
    receivedAt,
  );
}

/** A quote-reply's thread root, resolved after the row was written. */
export function updateInboxThread(
  sql: SqlStorage,
  eventId: string,
  threadRootId: string,
): void {
  sql.exec(
    `UPDATE turn_inbox SET thread_root_id = ? WHERE event_id = ?`,
    threadRootId,
    eventId,
  );
}

export function deleteInboxRows(sql: SqlStorage, eventIds: string[]): void {
  for (const id of eventIds)
    sql.exec(`DELETE FROM turn_inbox WHERE event_id = ?`, id);
}

export function bumpInboxAttempts(sql: SqlStorage, eventIds: string[]): void {
  for (const id of eventIds)
    sql.exec(
      `UPDATE turn_inbox SET attempts = attempts + 1 WHERE event_id = ?`,
      id,
    );
}

export function countInboxRows(sql: SqlStorage): number {
  const rows = sql
    .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM turn_inbox`)
    .toArray();
  return Number(rows[0]?.n ?? 0);
}

type InboxSqlRow = {
  event_id: string;
  room_id: string;
  sender: string;
  ts: number;
  body: string;
  thread_root_id: string | null;
  attachment: string | null;
  received_at: number;
  attempts: number;
} & Record<string, SqlStorageValue>;

/** Every pending row, oldest first (the order the messages arrived in). */
export function listInboxRows(sql: SqlStorage): InboxRow[] {
  return sql
    .exec<InboxSqlRow>(
      `SELECT event_id, room_id, sender, ts, body, thread_root_id, attachment, received_at, attempts
       FROM turn_inbox ORDER BY ts ASC, event_id ASC`,
    )
    .toArray()
    .map((row) => ({
      eventId: row.event_id,
      roomId: row.room_id,
      sender: row.sender,
      ts: Number(row.ts),
      body: row.body,
      ...(row.thread_root_id ? { threadRootId: row.thread_root_id } : {}),
      ...(row.attachment
        ? { attachment: parseAttachment(row.attachment) }
        : {}),
      receivedAt: Number(row.received_at),
      attempts: Number(row.attempts),
    }));
}

function parseAttachment(json: string): InboundAttachment {
  const parsed: unknown = JSON.parse(json);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { eventId?: unknown }).eventId !== 'string'
  )
    throw new Error('turn_inbox: malformed attachment column');
  return parsed as InboundAttachment;
}

/** The message a row was made from — what goes back into the ingest pipeline. */
export function inboundOfRow(row: InboxRow): InboundMessage {
  const { receivedAt: _receivedAt, attempts: _attempts, ...msg } = row;
  return msg;
}

export interface InboxReplayPlan {
  /** Rows to feed back into the ingest pipeline, oldest first. */
  replay: InboxRow[];
  /** Rows that used up their replays: notify the user and drop. */
  exhausted: InboxRow[];
  /** Rows whose turn is running in this instance right now (a restart, not a reset): leave alone. */
  skipped: InboxRow[];
}

export function planInboxReplay(
  rows: InboxRow[],
  opts: { inFlight: ReadonlySet<string>; maxReplays: number },
): InboxReplayPlan {
  const plan: InboxReplayPlan = { replay: [], exhausted: [], skipped: [] };
  for (const row of rows) {
    if (opts.inFlight.has(row.eventId)) plan.skipped.push(row);
    else if (row.attempts >= opts.maxReplays) plan.exhausted.push(row);
    else plan.replay.push(row);
  }
  return plan;
}

/**
 * The transaction id of the reply to a room message. Derived from the event
 * id, so a reply re-sent after a reset — by the replayed turn, or by the
 * durable outbox — is deduplicated by the homeserver instead of appearing
 * twice. Event ids are `$` + base64 (standard or url-safe); the id must not
 * contain `/`, whitespace or control characters, and stays under 255 bytes.
 */
export function replyTxnId(eventId: string): string {
  let safe = '';
  for (const ch of eventId) {
    const code = ch.charCodeAt(0);
    if (ch === '/') safe += '_';
    else if (ch === '+') safe += '-';
    else if (code > 0x20 && code !== 0x7f) safe += ch;
  }
  return `reply-${safe}`.slice(0, 255);
}

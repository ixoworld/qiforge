/**
 * The links behind a session's channel files (`channel.ts`), kept in the
 * user's own SQLite file in their own table, apart from the messages: the
 * messages, the model and the transcript carry only the `channel:`
 * reference, and `view_attachment` resolves it here once the turn that
 * brought the file has ended. A link is served until it expires (the
 * gateway signs links for 30 days; `exp` in the link); a row goes with its
 * session (`forgetSession`). Failures are logged and treated as a miss: a
 * missing link makes the file unavailable, never the turn.
 *
 * A row also keeps the Matrix event the file was posted as in the session
 * thread (`event_id`, `attachments/room-media.ts`): that room copy serves
 * the file when the link fails or has expired, so a row that carries one
 * outlives its link (the expiry sweep only removes rows without it). A
 * resend of the same file in a later turn refreshes the link and keeps the
 * event until the new post records its own.
 */
import type { DoSqliteDatabase } from '../sqlite/database';
import type { Logger } from '../plugin-api/types';
import type { ChannelMediaLink } from './channel';

/** The gateway's link lifetime, for a link that carries no readable `exp`. */
export const CHANNEL_LINK_DEFAULT_TTL_MS = 30 * 24 * 3600 * 1000;

/** When `url` stops working: its `exp` (unix seconds), else 30 days from `now`. */
export function channelLinkExpiry(url: string, now: number): number {
  let exp: string | null = null;
  try {
    exp = new URL(url).searchParams.get('exp');
  } catch {
    exp = null;
  }
  return exp && /^\d{1,12}$/.test(exp)
    ? Number(exp) * 1000
    : now + CHANNEL_LINK_DEFAULT_TTL_MS;
}

export class ChannelAttachmentLinkStore {
  private setupPromise: Promise<void> | undefined;

  constructor(
    private readonly db: Pick<DoSqliteDatabase, 'run' | 'get' | 'exec'>,
    private readonly log: Pick<Logger, 'warn'>,
    private readonly now: () => number = Date.now,
  ) {}

  private setup(): Promise<void> {
    this.setupPromise ??= this.createTables().catch((error: unknown) => {
      this.setupPromise = undefined;
      throw error;
    });
    return this.setupPromise;
  }

  private async createTables(): Promise<void> {
    await this.db.run(
      `CREATE TABLE IF NOT EXISTS channel_attachment_links (
         session_id TEXT NOT NULL,
         ref TEXT NOT NULL,
         binding_id TEXT NOT NULL,
         url TEXT NOT NULL,
         sha256 TEXT NOT NULL,
         expires_at INTEGER NOT NULL,
         event_id TEXT,
         UNIQUE (session_id, ref)
       )`,
    );
    // A table created before `event_id` existed (CREATE TABLE IF NOT
    // EXISTS leaves it as it was).
    const columns = await this.db.exec<{ name: string }>(
      'PRAGMA table_info(channel_attachment_links)',
    );
    if (!columns.some((column) => column.name === 'event_id'))
      await this.db.run(
        'ALTER TABLE channel_attachment_links ADD COLUMN event_id TEXT',
      );
    await this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_channel_attachment_links_expiry
       ON channel_attachment_links(expires_at)`,
    );
  }

  /**
   * Keep the links of a turn's files for its session (a resend refreshes
   * them, keeping a recorded room event), then sweep expired rows that have
   * no room copy.
   */
  async put(
    sessionId: string,
    links: ReadonlyArray<ChannelMediaLink & { ref: string }>,
  ): Promise<void> {
    if (links.length === 0) return;
    try {
      await this.setup();
      const now = this.now();
      for (const link of links)
        await this.db.run(
          `INSERT INTO channel_attachment_links
             (session_id, ref, binding_id, url, sha256, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (session_id, ref) DO UPDATE SET
             binding_id = excluded.binding_id, url = excluded.url,
             sha256 = excluded.sha256, expires_at = excluded.expires_at`,
          [
            sessionId,
            link.ref,
            link.bindingId,
            link.url,
            link.sha256,
            channelLinkExpiry(link.url, now),
          ],
        );
      await this.db.run(
        'DELETE FROM channel_attachment_links WHERE expires_at <= ? AND event_id IS NULL',
        [now],
      );
    } catch (error) {
      this.log.warn(
        `[attachments] could not keep the channel file links of ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The unexpired link behind `ref` in `sessionId`, if one is kept. */
  async get(
    sessionId: string,
    ref: string,
  ): Promise<ChannelMediaLink | undefined> {
    try {
      await this.setup();
      const row = await this.db.get<{
        url: string;
        sha256: string;
        binding_id: string;
      }>(
        `SELECT url, sha256, binding_id FROM channel_attachment_links
         WHERE session_id = ? AND ref = ? AND expires_at > ?`,
        [sessionId, ref, this.now()],
      );
      return row
        ? { url: row.url, sha256: row.sha256, bindingId: row.binding_id }
        : undefined;
    } catch (error) {
      this.log.warn(
        `[attachments] channel file link read failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  /**
   * Record the session-thread events the turn's files were posted as
   * (reference → event id). A failure is logged: the files are then served
   * by their links alone.
   */
  async setEventIds(
    sessionId: string,
    eventIds: ReadonlyMap<string, string>,
  ): Promise<void> {
    if (eventIds.size === 0) return;
    try {
      await this.setup();
      for (const [ref, eventId] of eventIds)
        await this.db.run(
          `UPDATE channel_attachment_links SET event_id = ?
           WHERE session_id = ? AND ref = ?`,
          [eventId, sessionId, ref],
        );
    } catch (error) {
      this.log.warn(
        `[attachments] could not keep the thread events of ${sessionId}'s channel files: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The session-thread event recorded for `ref`, expired link or not. */
  async eventIdOf(sessionId: string, ref: string): Promise<string | undefined> {
    try {
      await this.setup();
      const row = await this.db.get<{ event_id: string | null }>(
        `SELECT event_id FROM channel_attachment_links
         WHERE session_id = ? AND ref = ?`,
        [sessionId, ref],
      );
      return row?.event_id ?? undefined;
    } catch (error) {
      this.log.warn(
        `[attachments] channel file thread event read failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  /** Drop every link of a deleted session. */
  async forgetSession(sessionId: string): Promise<void> {
    await this.setup();
    await this.db.run(
      'DELETE FROM channel_attachment_links WHERE session_id = ?',
      [sessionId],
    );
  }
}

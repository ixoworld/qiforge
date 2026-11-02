/**
 * The links behind a session's channel files (`channel.ts`), kept in the
 * user's own SQLite file in their own table, apart from the messages: the
 * messages, the model and the transcript carry only the `channel:`
 * reference, and `view_attachment` resolves it here once the turn that
 * brought the file has ended. A row lives until its link expires (the
 * gateway signs links for 30 days; `exp` in the link) and goes with its
 * session (`forgetSession`). Failures are logged and treated as a miss: a
 * missing link makes the file unavailable, never the turn.
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
    private readonly db: Pick<DoSqliteDatabase, 'run' | 'get'>,
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
         UNIQUE (session_id, ref)
       )`,
    );
    await this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_channel_attachment_links_expiry
       ON channel_attachment_links(expires_at)`,
    );
  }

  /** Keep the links of a turn's files for its session (a resend refreshes them). */
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
          `INSERT OR REPLACE INTO channel_attachment_links
             (session_id, ref, binding_id, url, sha256, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
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
        'DELETE FROM channel_attachment_links WHERE expires_at <= ?',
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

  /** Drop every link of a deleted session. */
  async forgetSession(sessionId: string): Promise<void> {
    await this.setup();
    await this.db.run(
      'DELETE FROM channel_attachment_links WHERE session_id = ?',
      [sessionId],
    );
  }
}

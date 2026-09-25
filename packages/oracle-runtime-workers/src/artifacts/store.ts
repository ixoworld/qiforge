/**
 * Artefacts: long chat output kept as a document the user opens in a browser.
 *
 * The canonical copy is a row in the user's own SQLite, so it travels with
 * the working copy into the user's VFS file like the rest of their history.
 * The share copy is ciphertext in R2 under `art/<id>`, expiring with the
 * link; the key lives in the row and in the link's fragment. Creation is
 * idempotent per id, which is what lets a recovered run rebuild its reply
 * without minting a second document.
 */
import type { DoSqliteDatabase } from '../sqlite/database';
import type { ArtifactRef } from '../delivery/types';
import { artifactLink, type ArtifactLinkConfig } from './config';
import { newShareKey, sealArtifact } from './crypto';

export const ARTIFACT_ID_RE = /^[0-9a-f]{32}$/;

export function artifactObjectKey(artifactId: string): string {
  return `art/${artifactId}`;
}

/** A stable id for (run, source): the tool call id, or a spill's step key. */
export async function artifactIdFor(
  runId: string,
  source: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`artifact\0${runId}\0${source}`),
  );
  return Array.from(new Uint8Array(digest).slice(0, 16), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

type ArtifactRow = {
  artifact_id: string;
  session_id: string;
  title: string;
  content: string;
  bytes: number;
  share_key: string;
  created_at: string;
  expires_at: string;
  uploaded: number;
  revoked_at: string | null;
} & Record<string, string | number | null>;

export interface StoredArtifact {
  ref: ArtifactRef;
  sessionId: string;
  content: string;
  createdAt: string;
  revoked: boolean;
}

/** An artefact as its owner reads it: `url` only while the link works. */
export interface OwnedArtifact extends Omit<ArtifactRef, 'url'> {
  url?: string;
  sessionId: string;
  createdAt: string;
  revoked: boolean;
  content: string;
}

export class ArtifactStore {
  private setupPromise: Promise<void> | undefined;

  constructor(
    private readonly db: DoSqliteDatabase,
    private readonly config: ArtifactLinkConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  setup(): Promise<void> {
    this.setupPromise ??= this.db
      .run(
        `CREATE TABLE IF NOT EXISTS artifacts (
          artifact_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          title TEXT NOT NULL,
          mime TEXT NOT NULL,
          content TEXT NOT NULL,
          bytes INTEGER NOT NULL,
          share_key TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          uploaded INTEGER NOT NULL DEFAULT 0,
          revoked_at TEXT
        )`,
      )
      .then(() => undefined)
      .catch((error: unknown) => {
        this.setupPromise = undefined;
        throw error;
      });
    return this.setupPromise;
  }

  private refOf(row: ArtifactRow): ArtifactRef {
    return {
      artifactId: row.artifact_id,
      title: row.title,
      url: artifactLink(this.config, row.artifact_id, row.share_key),
      mime: 'text/markdown',
      bytes: Number(row.bytes),
      expiresAt: row.expires_at,
    };
  }

  private row(artifactId: string): Promise<ArtifactRow | undefined> {
    return this.db.get<ArtifactRow>(
      `SELECT artifact_id, session_id, title, content, bytes, share_key,
        created_at, expires_at, uploaded, revoked_at
       FROM artifacts WHERE artifact_id = ?`,
      [artifactId],
    );
  }

  /** Create (or return the existing) artefact and make sure its share copy exists. */
  async create(input: {
    artifactId: string;
    sessionId: string;
    runId: string;
    title: string;
    content: string;
  }): Promise<ArtifactRef> {
    await this.setup();
    const createdAt = new Date(this.now());
    await this.db.run(
      `INSERT OR IGNORE INTO artifacts (artifact_id, session_id, run_id, title,
        mime, content, bytes, share_key, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'text/markdown', ?, ?, ?, ?, ?)`,
      [
        input.artifactId,
        input.sessionId,
        input.runId,
        input.title,
        input.content,
        new TextEncoder().encode(input.content).byteLength,
        newShareKey(),
        createdAt.toISOString(),
        new Date(createdAt.getTime() + this.config.ttlMs).toISOString(),
      ],
    );
    const row = await this.row(input.artifactId);
    if (!row) throw new Error(`artifacts: ${input.artifactId} was not stored`);
    if (!Number(row.uploaded) && !row.revoked_at) {
      await this.config.bucket.put(
        artifactObjectKey(row.artifact_id),
        await sealArtifact(row.share_key, {
          v: 1,
          title: row.title,
          mime: 'text/markdown',
          content: row.content,
          createdAt: row.created_at,
        }),
        {
          httpMetadata: { contentType: 'application/octet-stream' },
          customMetadata: { expiresAt: row.expires_at },
        },
      );
      await this.db.run(
        'UPDATE artifacts SET uploaded = 1 WHERE artifact_id = ?',
        [row.artifact_id],
      );
    }
    return this.refOf(row);
  }

  async get(artifactId: string): Promise<StoredArtifact | undefined> {
    await this.setup();
    const row = await this.row(artifactId);
    if (!row) return undefined;
    return {
      ref: this.refOf(row),
      sessionId: row.session_id,
      content: row.content,
      createdAt: row.created_at,
      revoked: row.revoked_at !== null,
    };
  }

  /** Delete the share copy; the canonical copy stays with the user. */
  async revoke(artifactId: string): Promise<boolean> {
    await this.setup();
    const row = await this.row(artifactId);
    if (!row) return false;
    await this.config.bucket.delete(artifactObjectKey(artifactId));
    if (!row.revoked_at)
      await this.db.run(
        'UPDATE artifacts SET revoked_at = ? WHERE artifact_id = ?',
        [new Date(this.now()).toISOString(), artifactId],
      );
    return true;
  }

  /**
   * A deleted session takes its artefacts with it: the share copies first,
   * so a failed delete keeps the rows (and the links still expire on time).
   */
  async deleteForSession(sessionId: string): Promise<number> {
    await this.setup();
    const rows = await this.db.exec<{ artifact_id: string }>(
      'SELECT artifact_id FROM artifacts WHERE session_id = ?',
      [sessionId],
    );
    if (rows.length === 0) return 0;
    await this.config.bucket.delete(
      rows.map((row) => artifactObjectKey(row.artifact_id)),
    );
    await this.db.run('DELETE FROM artifacts WHERE session_id = ?', [
      sessionId,
    ]);
    return rows.length;
  }
}

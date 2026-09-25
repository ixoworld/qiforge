/**
 * Test-only Durable Object driving `ArtifactStore` over real DO SQLite and
 * the test R2 bucket inside workerd. Bound as `ARTIFACT_STORE_TEST` by
 * `test/wrangler.test.jsonc`. Not part of the runtime.
 */
import { DurableObject } from 'cloudflare:workers';
import { DoSqliteDatabase } from '../sqlite/database';
import type { ArtifactRef } from '../delivery/types';
import { artifactLinkConfig } from './config';
import { ArtifactStore, type StoredArtifact } from './store';

export class ArtifactStoreTestDO extends DurableObject<{
  ARTIFACT_TEST: R2Bucket;
}> {
  private db: DoSqliteDatabase | undefined;
  private store: ArtifactStore | undefined;
  private nowMs = Date.parse('2026-09-25T09:00:00.000Z');
  private viewerUrl: string | undefined;

  private async artifacts(): Promise<ArtifactStore> {
    if (!this.db || !this.db.isOpen) {
      this.db = await DoSqliteDatabase.open(this.ctx, 'artifacts-test.db');
      this.store = undefined;
    }
    const config = artifactLinkConfig({
      ARTIFACT_BUCKET: this.env.ARTIFACT_TEST,
      ORACLE_PUBLIC_URL: 'https://oracle.test',
      ARTIFACT_VIEWER_URL: this.viewerUrl,
      ARTIFACT_LINK_TTL_DAYS: '30',
    });
    if (!config) throw new Error('artifact config did not resolve');
    this.store ??= new ArtifactStore(this.db, config, () => this.nowMs);
    return this.store;
  }

  async configure(opts: { viewerUrl?: string }): Promise<void> {
    this.viewerUrl = opts.viewerUrl;
    this.store = undefined;
  }

  async create(input: {
    artifactId: string;
    title: string;
    content: string;
    sessionId?: string;
  }): Promise<ArtifactRef> {
    return (await this.artifacts()).create({
      sessionId: '$session',
      ...input,
      runId: 'run-1',
    });
  }

  async get(artifactId: string): Promise<StoredArtifact | undefined> {
    return (await this.artifacts()).get(artifactId);
  }

  async revoke(artifactId: string): Promise<boolean> {
    return (await this.artifacts()).revoke(artifactId);
  }

  async deleteForSession(sessionId: string): Promise<number> {
    return (await this.artifacts()).deleteForSession(sessionId);
  }

  /** Simulate a crash between the row insert and the share-copy upload. */
  async forgetUpload(artifactId: string): Promise<void> {
    await this.artifacts();
    await this.db!.run(
      'UPDATE artifacts SET uploaded = 0 WHERE artifact_id = ?',
      [artifactId],
    );
    await this.env.ARTIFACT_TEST.delete(`art/${artifactId}`);
  }
}

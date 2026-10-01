/**
 * Test-only Durable Object driving `ArtifactStore` over real DO SQLite and
 * the test R2 bucket inside workerd. Bound as `ARTIFACT_STORE_TEST` by
 * `test/wrangler.test.jsonc`. Not part of the runtime.
 */
import { DurableObject } from 'cloudflare:workers';
import { DoSqliteDatabase } from '../sqlite/database';
import type { ArtifactRef } from '../delivery/types';
import { artifactStorageConfig } from './config';
import { ArtifactStore, type StoredArtifact } from './store';

export class ArtifactStoreTestDO extends DurableObject<{
  ARTIFACT_TEST: R2Bucket;
}> {
  private db: DoSqliteDatabase | undefined;
  private store: ArtifactStore | undefined;
  private nowMs = Date.parse('2026-09-25T09:00:00.000Z');
  private viewerUrl: string | undefined;
  private publicUrl: string | undefined = 'https://oracle.test';

  private async artifacts(): Promise<ArtifactStore> {
    if (!this.db || !this.db.isOpen) {
      this.db = await DoSqliteDatabase.open(this.ctx, 'artifacts-test.db');
      this.store = undefined;
    }
    const config = artifactStorageConfig({
      ARTIFACT_BUCKET: this.env.ARTIFACT_TEST,
      ORACLE_PUBLIC_URL: this.publicUrl,
      ARTIFACT_VIEWER_URL: this.viewerUrl,
      ARTIFACT_LINK_TTL_DAYS: '30',
    });
    if (!config) throw new Error('artifact config did not resolve');
    this.store ??= new ArtifactStore(this.db, config, () => this.nowMs);
    return this.store;
  }

  /** `publicUrl: null` removes the public origin, as an operator might. */
  async configure(opts: {
    viewerUrl?: string;
    publicUrl?: string | null;
  }): Promise<void> {
    this.viewerUrl = opts.viewerUrl;
    if (opts.publicUrl !== undefined)
      this.publicUrl = opts.publicUrl ?? undefined;
    this.store = undefined;
  }

  async canShare(): Promise<boolean> {
    return (await this.artifacts()).canShare;
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

  /** The error `create` fails with, or null when it succeeds. */
  async createError(input: {
    artifactId: string;
    title: string;
    content: string;
  }): Promise<string | null> {
    try {
      await this.create(input);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
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

import { Logger } from '@nestjs/common';
import { createClient, type MatrixClient } from 'matrix-js-sdk';

/** Matrix admin credentials needed to bootstrap the editor client. */
export interface EditorMatrixClientConfig {
  baseUrl: string;
  userId: string;
  accessToken: string;
}

/**
 * Singleton wrapper around a `matrix-js-sdk` `MatrixClient`. Used by
 * `@ixo/matrix-crdt` to read/write BlockNote Y.js documents.
 *
 * No `startClient()` / sync is performed — matrix-crdt's `MatrixReader`
 * explicitly tells consumers NOT to use the Sync API and polls the
 * `/events` endpoint itself. Initialization here is just `createClient`,
 * which is synchronous-ish (a few ms).
 */
export class EditorMatrixClient {
  private static instance: EditorMatrixClient | null = null;

  private readonly cfg: EditorMatrixClientConfig;
  private matrixClient: MatrixClient | null = null;
  private isInitialized = false;
  private initializationPromise: Promise<void> | null = null;

  private readonly logger = new Logger('EditorMatrixClient');

  private constructor(cfg: EditorMatrixClientConfig) {
    this.cfg = cfg;
  }

  /**
   * Get the singleton instance. First caller supplies the Matrix admin
   * config used for the lifetime of the process; subsequent callers
   * receive the same instance and the config argument is ignored.
   */
  public static getInstance(cfg: EditorMatrixClientConfig): EditorMatrixClient {
    if (!EditorMatrixClient.instance) {
      EditorMatrixClient.instance = new EditorMatrixClient(cfg);
    }
    return EditorMatrixClient.instance;
  }

  /**
   * Test-only — reset the singleton so tests can swap the underlying client.
   */
  public static resetForTesting(): void {
    EditorMatrixClient.instance = null;
  }

  /**
   * Build the underlying `matrix-js-sdk` client. Idempotent — safe to call
   * concurrently; only the first call does work.
   */
  public async init(): Promise<void> {
    if (this.isInitialized && this.matrixClient) return;
    if (this.initializationPromise) return this.initializationPromise;

    this.initializationPromise = this.performInitialization();
    try {
      await this.initializationPromise;
    } finally {
      this.initializationPromise = null;
    }
  }

  private async performInitialization(): Promise<void> {
    const { baseUrl, userId, accessToken } = this.cfg;
    if (!baseUrl || !userId || !accessToken) {
      throw new Error(
        'Missing Matrix configuration. Editor plugin requires MATRIX_BASE_URL, MATRIX_ORACLE_ADMIN_USER_ID, MATRIX_ORACLE_ADMIN_ACCESS_TOKEN.',
      );
    }

    this.matrixClient = createClient({
      baseUrl,
      accessToken,
      userId,
      timelineSupport: true,
      fetchFn: fetch,
    });
    this.isInitialized = true;
    this.logger.log('EditorMatrixClient ready (no sync, polling-only mode)');
  }

  public getClient(): MatrixClient {
    if (!this.isInitialized || !this.matrixClient) {
      throw new Error(
        'EditorMatrixClient not initialized. Call await init() first.',
      );
    }
    return this.matrixClient;
  }

  public isReady(): boolean {
    return this.isInitialized && this.matrixClient !== null;
  }

  public async waitUntilReady(): Promise<void> {
    if (this.isReady()) return;
    await this.init();
  }
}

/**
 * Resolve the `MatrixClient` used by editor tools. Prefers the
 * `matrixClient` from the plugin's runtime config (host-provided DI);
 * otherwise lazily constructs the internal singleton.
 *
 * Centralised so every call site (editor-agent, apply-sandbox-output,
 * standalone-editor-tool) goes through one resolution path.
 */
export async function resolveEditorMatrixClient(
  cfg: EditorMatrixClientConfig & { matrixClient?: MatrixClient },
): Promise<MatrixClient> {
  if (cfg.matrixClient) return cfg.matrixClient;
  const inst = EditorMatrixClient.getInstance(cfg);
  await inst.init();
  return inst.getClient();
}

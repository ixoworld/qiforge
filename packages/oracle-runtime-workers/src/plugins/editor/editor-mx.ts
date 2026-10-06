import { createClient, type MatrixClient } from 'matrix-js-sdk';
import { createConsoleLogger } from '../../core/utils';

/** Matrix admin credentials needed to bootstrap the editor client. */
export interface EditorMatrixClientConfig {
  baseUrl: string;
  userId: string;
  accessToken: string;
}

const logger = createConsoleLogger({ module: 'editor-mx' });

/**
 * Per-isolate wrapper around a `matrix-js-sdk` `MatrixClient`, one live
 * instance per set of credentials (see {@link EditorMatrixClient.getInstance}). Used
 * by `@ixo/matrix-crdt` to read/write BlockNote Y.js documents.
 *
 * No `startClient()` / sync is performed — matrix-crdt's `MatrixReader`
 * explicitly tells consumers NOT to use the Sync API and polls the
 * `/events` endpoint itself. No crypto is initialised either
 * (`initRustCrypto` is never called): editor rooms are not E2EE at the doc
 * level in this runtime — matrix-crdt stores updates in its own plain state
 * events — so a crypto-less client is correct, and the crypto WASM stays
 * untouched outside the gateway Durable Object.
 */
export class EditorMatrixClient {
  private static instance: EditorMatrixClient | null = null;

  private readonly cfg: EditorMatrixClientConfig;
  private matrixClient: MatrixClient | null = null;
  private isInitialized = false;
  private initializationPromise: Promise<void> | null = null;

  private constructor(cfg: EditorMatrixClientConfig) {
    this.cfg = cfg;
  }

  /**
   * Get the isolate's instance for these credentials. Callers pass the
   * credentials the gateway handed out for the current request; when they
   * differ from the cached instance's (the gateway re-minted the device
   * token, or the homeserver or user changed) a new instance replaces it, so
   * a warm isolate never keeps sending a revoked token. Requests already
   * holding the previous client finish with it; it runs no sync loop, so
   * nothing needs stopping.
   */
  public static getInstance(cfg: EditorMatrixClientConfig): EditorMatrixClient {
    const current = EditorMatrixClient.instance;
    if (current && current.hasCredentials(cfg)) return current;
    const next = new EditorMatrixClient({
      baseUrl: cfg.baseUrl,
      userId: cfg.userId,
      accessToken: cfg.accessToken,
    });
    EditorMatrixClient.instance = next;
    return next;
  }

  private hasCredentials(cfg: EditorMatrixClientConfig): boolean {
    return (
      this.cfg.baseUrl === cfg.baseUrl &&
      this.cfg.userId === cfg.userId &&
      this.cfg.accessToken === cfg.accessToken
    );
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
        'Missing Matrix configuration for the editor client (base URL, user id and the bot device token from the gateway).',
      );
    }

    this.matrixClient = createClient({
      baseUrl,
      accessToken,
      userId,
      timelineSupport: true,
      // Never hand the SDK the bare global: workerd rejects `fetch` invoked
      // with a foreign `this` ("Illegal invocation"), and the SDK calls
      // `this.fetchFn(...)` on its own http-api object.
      fetchFn: (input, init) => fetch(input, init),
    });
    this.isInitialized = true;
    logger.log('EditorMatrixClient ready (no sync, polling-only mode)');
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
 * `matrixClient` from the plugin's runtime config (host/test-provided);
 * otherwise lazily constructs the internal instance, rebuilt whenever the
 * credentials passed in differ from the ones it was built with.
 *
 * Centralised so every call site (standalone-editor-tool, the flows plugin's
 * flow-doc) goes through one resolution path.
 */
export async function resolveEditorMatrixClient(
  cfg: EditorMatrixClientConfig & { matrixClient?: MatrixClient },
): Promise<MatrixClient> {
  if (cfg.matrixClient) return cfg.matrixClient;
  const inst = EditorMatrixClient.getInstance(cfg);
  await inst.init();
  return inst.getClient();
}

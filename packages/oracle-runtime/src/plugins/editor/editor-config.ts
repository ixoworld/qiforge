/**
 * Matrix + provider configuration shared by every editor surface (and by the
 * flows plugin, which opens the same Matrix-backed Y.Docs).
 *
 * The three Matrix env vars this reads are owned by the runtime's core base env
 * schema, so the editor plugin declares no `configSchema` of its own — it only
 * extracts typed values out of the already-validated `ctx.config`.
 */

import type { MatrixClient } from 'matrix-js-sdk';

/** Matrix admin credentials the editor uses to read/write Y.Docs. */
export interface BlocknoteToolsMatrixConfig {
  baseUrl: string;
  accessToken: string;
  userId: string;
}

/**
 * Build the provider/document config from Matrix credentials. Called once per
 * request by the editor plugin and per call by the flows plugin.
 *
 * `writer.retryIfForbiddenInterval` / `maxForbiddenRetries` are deliberately
 * tight: matrix-crdt defaults to retrying a rejected write every 30s up to 3
 * times, which would keep a tool call open for ~90s before it could report the
 * truth. Room power levels cannot change mid-call, so a rejected write is
 * final — fail fast and let the caller surface `needs_access`.
 */
export function buildBlocknoteToolsConfig(matrix: BlocknoteToolsMatrixConfig) {
  return {
    matrix: {
      baseUrl: matrix.baseUrl,
      accessToken: matrix.accessToken,
      userId: matrix.userId,
      initialSyncTimeoutMs: 30_000,
    },
    provider: {
      docName: 'document',
      enableAwareness: false,
      retryAttempts: 3,
      retryDelayMs: 5_000,
      flushInterval: 10,
      retryIfForbiddenInterval: 1_000,
      maxForbiddenRetries: 1,
    },
    blocknote: {
      defaultBlockId: undefined,
      blockNamespace: undefined,
      mutableAttributeKeys: [] as string[],
    },
  };
}

/**
 * The editor's config, optionally augmented with a host-provided
 * `MatrixClient`. When `matrixClient` is set, `resolveEditorMatrixClient` uses
 * it directly; when absent, the editor constructs its internal singleton from
 * the Matrix credentials.
 */
export type BlocknoteToolsConfig = ReturnType<
  typeof buildBlocknoteToolsConfig
> & {
  matrixClient?: MatrixClient;
};

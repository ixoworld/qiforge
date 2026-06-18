/**
 * Connect to a flow's Matrix-backed Y.Doc and run a unit of work against it,
 * then dispose. This is the only place the plugin touches Matrix; every read
 * and mutation goes through `withFlowDoc`. We reuse the editor plugin's
 * provider, config builder, and matrix-client resolver verbatim — the flows
 * plugin never re-implements the connection.
 *
 * `flowRef` IS the Matrix room id (opaque to the agent, §1). The default flow
 * (when the agent omits `ref`) is the one bound to `state.editorRoomId`.
 */
import type { Doc as YDoc } from 'yjs';
import type { MatrixClient } from 'matrix-js-sdk';
import { MatrixProviderManager, type AppConfig } from '../editor/provider.js';
import { buildBlocknoteToolsConfig } from '../editor/blocknote-tools.js';
import { resolveEditorMatrixClient } from '../editor/editor-mx.js';
import { isUserInRoom } from '../../matrix/room-membership.js';
import type { RuntimeContext } from '../../plugin-api/types.js';
import { FlowError } from './errors.js';

interface MatrixCreds {
  baseUrl: string;
  userId: string;
  accessToken: string;
}

function readMatrixCreds(rtCtx: RuntimeContext): MatrixCreds {
  const cfg = rtCtx.config as Record<string, unknown>;
  const baseUrl = cfg.MATRIX_BASE_URL;
  const userId = cfg.MATRIX_ORACLE_ADMIN_USER_ID;
  const accessToken = cfg.MATRIX_ORACLE_ADMIN_ACCESS_TOKEN;
  if (
    typeof baseUrl !== 'string' ||
    typeof userId !== 'string' ||
    typeof accessToken !== 'string'
  ) {
    throw new FlowError('error', 'Matrix is not configured for this oracle.');
  }
  return { baseUrl, userId, accessToken };
}

/** The flow handle for a request: the explicit `ref`, else the open flow's room. */
export function resolveFlowRef(rtCtx: RuntimeContext, ref?: string): string {
  const candidate = ref ?? rtCtx.history.state.editorRoomId;
  if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  throw new FlowError(
    'no_flow_ref',
    'No flow is open. Create a flow first, or specify which flow to use.',
  );
}

/** Enforce the room-membership guard (fail closed). */
export async function requireRoomMembership(
  rtCtx: RuntimeContext,
  roomId: string,
): Promise<void> {
  if (!(await isUserInRoom(roomId, rtCtx.user.matrixUserId))) {
    throw new FlowError('not_in_room', 'You do not have access to this flow.');
  }
}

/**
 * Resolve a Matrix client for compile-driven authoring (`setupFlowFromBaseUcan`),
 * which manages its own provider/doc rather than taking the one `withFlowDoc` opens.
 */
export async function resolveFlowsMatrixClient(
  rtCtx: RuntimeContext,
  injectedClient: MatrixClient | undefined,
): Promise<MatrixClient> {
  return resolveEditorMatrixClient({
    ...readMatrixCreds(rtCtx),
    matrixClient: injectedClient,
  });
}

function buildAppConfig(creds: MatrixCreds, roomId: string): AppConfig {
  const base = buildBlocknoteToolsConfig(creds);
  return {
    matrix: { ...base.matrix, room: { type: 'id', value: roomId } },
    provider: { ...base.provider },
    blocknote: { ...base.blocknote },
  };
}

/**
 * Resolve the flow ref, enforce the room-membership guard (fail closed), open
 * the room's Y.Doc, run `fn`, and always dispose the provider.
 */
export async function withFlowDoc<T>(
  rtCtx: RuntimeContext,
  ref: string | undefined,
  injectedClient: MatrixClient | undefined,
  fn: (doc: YDoc, roomId: string) => Promise<T>,
): Promise<T> {
  const roomId = resolveFlowRef(rtCtx, ref);
  const inRoom = await isUserInRoom(roomId, rtCtx.user.matrixUserId);
  if (!inRoom) {
    throw new FlowError('not_in_room', 'You do not have access to this flow.');
  }

  const creds = readMatrixCreds(rtCtx);
  const matrixClient = await resolveEditorMatrixClient({
    ...creds,
    matrixClient: injectedClient,
  });
  const manager = new MatrixProviderManager(
    matrixClient,
    buildAppConfig(creds, roomId),
  );
  try {
    const { doc } = await manager.init();
    return await fn(doc, roomId);
  } finally {
    await manager.dispose();
  }
}

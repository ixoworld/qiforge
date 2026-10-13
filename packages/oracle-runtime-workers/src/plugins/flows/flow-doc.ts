/**
 * Connect to a flow's Matrix-backed Y.Doc and run a unit of work against it,
 * then dispose. This is the only place the plugin touches Matrix; every read
 * and mutation goes through `withFlowDoc`. We reuse the editor plugin's
 * provider, config builder, and matrix-client resolver verbatim — the flows
 * plugin never re-implements the connection.
 *
 * `flowRef` IS the Matrix room id (opaque to the agent). The default flow
 * (when the agent omits `ref`) is the one bound to `state.editorRoomId`.
 */
import type { Doc as YDoc } from 'yjs';
import type { MatrixClient } from 'matrix-js-sdk';
import {
  DocWriteGuard,
  MatrixProviderManager,
  type AppConfig,
  type DocWriteFailure,
} from '../editor/provider';
import { buildBlocknoteToolsConfig } from '../editor/editor-config';
import { resolveEditorMatrixClient } from '../editor/editor-mx';
import { isUserInRoom } from '../editor/room-membership';
import type { RuntimeContext } from '../../plugin-api/types';
import { FlowError } from './errors';

interface MatrixCreds {
  baseUrl: string;
  userId: string;
  accessToken: string;
}

async function readMatrixCreds(rtCtx: RuntimeContext): Promise<MatrixCreds> {
  try {
    const { baseUrl, userId, accessToken } =
      await rtCtx.matrix.botCredentials();
    return { baseUrl, userId, accessToken };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new FlowError(
      'error',
      `Matrix is not available for this oracle: ${detail}`,
    );
  }
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
  if (!(await isUserInRoom(rtCtx, roomId, rtCtx.user.matrixUserId))) {
    throw new FlowError('not_in_room', 'You do not have access to this flow.');
  }
}

/**
 * The tool error for a write that did not reach the room:
 *  - refused as forbidden → `needs_access` (nothing was written);
 *  - refused with a client error (e.g. too large) → `error` (nothing was written);
 *  - not acknowledged (server errors, network, timeout) → `write_not_saved`:
 *    the change may have landed, so the flow must be re-read before any retry.
 */
function writeFailureError(failure: DocWriteFailure): FlowError {
  if (failure.kind === 'forbidden')
    return new FlowError(
      'needs_access',
      'The flow was not saved: this assistant is not allowed to edit this flow. ' +
        'Ask a room admin to give it edit rights, then try again.',
    );
  if (!failure.mayHaveLanded)
    return new FlowError(
      'error',
      `The flow was not saved: the homeserver refused the change (${failure.detail}).`,
    );
  return new FlowError(
    'write_not_saved',
    `The change may or may not have been saved: the homeserver did not acknowledge it (${failure.detail}). ` +
      'Re-read the flow (read_flow or get_step) before retrying, so the change is not applied twice.',
  );
}

/**
 * Run compile-driven authoring (`setupFlowFromBaseUcan`), which opens and
 * disposes its own provider, against a Matrix client whose document writes
 * are bounded ({@link DocWriteGuard}, `drain` mode: the editor's own writer
 * is configured to retry rejected writes for minutes). A write the
 * homeserver refused or that could not be delivered becomes a tool error.
 */
export async function withFlowsCompileClient<T>(
  rtCtx: RuntimeContext,
  injectedClient: MatrixClient | undefined,
  fn: (client: MatrixClient) => Promise<T>,
): Promise<T> {
  const client = await resolveEditorMatrixClient({
    ...(await readMatrixCreds(rtCtx)),
    matrixClient: injectedClient,
  });
  const guard = new DocWriteGuard(client, { onGiveUp: 'drain' });
  try {
    const result = await raceAbort(rtCtx, () => fn(guard.client));
    if (guard.failure) throw writeFailureError(guard.failure);
    return result;
  } finally {
    guard.close();
  }
}

/**
 * Settle with `start()`'s result, or reject as soon as the request is
 * aborted. `start` runs only when the request is still live: a promise
 * created before an abort check that then throws would be left with no
 * handler, and its later rejection would go unhandled. Once started, the
 * work stays attached to the race, so a rejection it produces after the
 * abort is handled (the caller already has the abort as its error).
 */
function raceAbort<T>(
  rtCtx: RuntimeContext,
  start: () => Promise<T>,
): Promise<T> {
  const signal = rtCtx.abortSignal;
  signal.throwIfAborted();
  const work = start();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new Error('Request aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([work, aborted]).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort);
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
 * the room's Y.Doc, run `fn`, wait until every change `fn` made has reached
 * the room, and always dispose the provider — on success, on a tool error,
 * on abort and on a timeout.
 *
 * `fn` returning is not success on its own: Y.Doc edits apply locally at
 * once and reach Matrix later. A forbidden write is `needs_access`; one
 * refused with a client error is an `error`; one the homeserver never
 * acknowledged (server errors, network, or the flush timeout ran out) is
 * `write_not_saved` — see {@link writeFailureError}.
 */
export async function withFlowDoc<T>(
  rtCtx: RuntimeContext,
  ref: string | undefined,
  injectedClient: MatrixClient | undefined,
  fn: (doc: YDoc, roomId: string) => Promise<T>,
): Promise<T> {
  rtCtx.abortSignal.throwIfAborted();
  const roomId = resolveFlowRef(rtCtx, ref);
  await requireRoomMembership(rtCtx, roomId);

  const creds = await readMatrixCreds(rtCtx);
  const matrixClient = await resolveEditorMatrixClient({
    ...creds,
    matrixClient: injectedClient,
  });
  const manager = new MatrixProviderManager(
    matrixClient,
    buildAppConfig(creds, roomId),
  );
  try {
    const { doc } = await raceAbort(rtCtx, () => manager.init());
    const result = await raceAbort(rtCtx, () => fn(doc, roomId));
    const failure = await raceAbort(rtCtx, () => manager.flush());
    if (failure) throw writeFailureError(failure);
    return result;
  } finally {
    await manager.dispose();
  }
}

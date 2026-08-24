/**
 * Opening a document, and the single choke point every write goes through.
 *
 * `applyDocumentEdit` is the only function in this plugin that mutates a
 * document. It enforces, in this order:
 *
 *   1. a live flow is read-only            → `read_only_flow`
 *   2. the provider already knows it cannot write → `needs_access`
 *   3. the oracle's power level is below the room's write threshold → `needs_access`
 *   4. the prop allowlist (the caller's `plan` step) → `prop_not_editable` etc.
 *   5. one `doc.transact()` for the whole batch
 *   6. `await provider.waitForFlush()` **before** success is reported
 *   7. a post-flush write check                → `needs_access`
 *
 * Steps 6 and 7 exist because matrix-crdt writes are fire-and-forget: a Y.Doc
 * mutation always "succeeds" locally, and a homeserver rejection surfaces only
 * once the batched update is actually sent. Reporting success before the flush
 * is how tools ended up claiming edits that never landed.
 */

import { Logger } from '@nestjs/common';
import type { MatrixClient } from 'matrix-js-sdk';
import type * as Y from 'yjs';

import {
  EDIT_ORIGIN,
  readDocumentTitle,
  seedDocumentTitle,
} from './document-model.js';
import {
  editorError,
  flushTimeout,
  isEditorFailure,
  needsAccess,
  readOnlyFlow,
  type EditorFailure,
} from './failures.js';
import {
  MatrixProviderManager,
  RoomNotAccessibleError,
  type AppConfig,
} from './provider.js';

const logger = new Logger('EditorContentSession');

/** The Matrix event type matrix-crdt writes Y.Doc updates as. */
const CRDT_UPDATE_EVENT_TYPE = 'matrix-crdt.doc_update';

/** Rooms whose canonical alias starts with this hold live flows. */
const FLOW_ALIAS_PREFIX = '#flow-';

/** How long to wait for a write to reach the homeserver before giving up. */
const FLUSH_TIMEOUT_MS = 20_000;

/**
 * What the write path needs from the CRDT provider. `MatrixProvider` satisfies
 * it; narrowing keeps the guards testable without a Matrix connection.
 */
export interface DocumentWriter {
  readonly canWrite: boolean;
  waitForFlush(): Promise<void>;
}

/** What the write path needs from the Matrix client. */
export interface RoomStateReader {
  getUserId(): string | null;
  getStateEvent(
    roomId: string,
    eventType: string,
    stateKey: string,
  ): Promise<Record<string, unknown>>;
}

export interface DocumentSession {
  doc: Y.Doc;
  provider: DocumentWriter;
  matrixClient: RoomStateReader;
  roomId: string;
  /** Canonical alias, when the homeserver exposes one. */
  alias: string | undefined;
  /** True when the room is a live flow — readable, never writable. */
  isFlow: boolean;
}

async function resolveRoomId(
  matrixClient: MatrixClient,
  appConfig: AppConfig,
): Promise<string> {
  const room = appConfig.matrix.room;
  if (room.type === 'id') return room.value;
  const resolved = await matrixClient.getRoomIdForAlias(room.value);
  return resolved.room_id;
}

/**
 * The room's display name from `m.room.name`, used to seed an untitled
 * document. Same reasoning as `resolveAlias`: the editor's Matrix client runs
 * without the sync API, so the client-side room store is not a reliable source
 * of state and the event is read directly.
 */
async function readRoomName(
  matrixClient: RoomStateReader,
  roomId: string,
): Promise<string | undefined> {
  try {
    const state = await matrixClient.getStateEvent(roomId, 'm.room.name', '');
    const name = state?.name;
    return typeof name === 'string' && name.trim().length > 0
      ? name
      : undefined;
  } catch {
    return undefined;
  }
}

async function resolveAlias(
  matrixClient: MatrixClient,
  appConfig: AppConfig,
  roomId: string,
): Promise<string | undefined> {
  if (appConfig.matrix.room.type === 'alias')
    return appConfig.matrix.room.value;

  // The editor's Matrix client runs without the sync API, so the client-side
  // room store is not a reliable source of state — read the state event.
  try {
    const state: Record<string, unknown> = await matrixClient.getStateEvent(
      roomId,
      'm.room.canonical_alias',
      '',
    );
    const alias = state?.alias;
    return typeof alias === 'string' ? alias : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Open the room's Y.Doc, run `work`, and always dispose the provider.
 *
 * Access problems come back as typed failures rather than exceptions, so every
 * tool can return them straight to the agent.
 */
export async function withDocument<T>(
  params: { matrixClient: MatrixClient; appConfig: AppConfig },
  work: (session: DocumentSession) => Promise<T>,
): Promise<T | EditorFailure> {
  const { matrixClient, appConfig } = params;

  let roomId: string;
  try {
    roomId = await resolveRoomId(matrixClient, appConfig);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return editorError(`Could not resolve the document's room: ${detail}`);
  }

  const manager = new MatrixProviderManager(matrixClient, appConfig);
  try {
    const { doc, provider } = await manager.init();
    const alias = await resolveAlias(matrixClient, appConfig, roomId);
    return await work({
      doc,
      provider,
      matrixClient,
      roomId,
      alias,
      isFlow: isFlowAlias(alias),
    });
  } catch (error) {
    if (error instanceof RoomNotAccessibleError) {
      return needsAccess(roomId, 'this assistant cannot open the document');
    }
    const detail = error instanceof Error ? error.message : String(error);
    logger.warn(`Failed to open document ${roomId}: ${detail}`);
    return editorError(`Could not open the document: ${detail}`, roomId);
  } finally {
    await manager.dispose();
  }
}

/** A live flow's room alias is `#flow-…`; a page's is `#page-…`. */
export function isFlowAlias(alias: string | undefined): boolean {
  return typeof alias === 'string' && alias.startsWith(FLOW_ALIAS_PREFIX);
}

/**
 * Whether the oracle's power level clears the room's threshold for CRDT
 * updates. Collaborative rooms are created with `events_default: 50` and
 * `users_default: 0`, so an un-granted oracle is below the bar and every write
 * it makes is rejected.
 *
 * Fails open: when the power levels cannot be read, the post-flush check is
 * still authoritative.
 */
export async function canOracleWrite(
  session: Pick<DocumentSession, 'matrixClient' | 'roomId'>,
): Promise<boolean> {
  const selfId = session.matrixClient.getUserId();
  if (!selfId) return true;

  let content: Record<string, unknown>;
  try {
    content = await session.matrixClient.getStateEvent(
      session.roomId,
      'm.room.power_levels',
      '',
    );
  } catch {
    return true;
  }
  if (!content || typeof content !== 'object') return true;

  const numberAt = (source: unknown, key: string, fallback: number): number => {
    if (!source || typeof source !== 'object') return fallback;
    const value = Object.getOwnPropertyDescriptor(source, key)?.value;
    return typeof value === 'number' ? value : fallback;
  };

  const usersDefault = numberAt(content, 'users_default', 0);
  const selfLevel = numberAt(content.users, selfId, usersDefault);
  const eventsDefault = numberAt(content, 'events_default', 0);
  const required = numberAt(
    content.events,
    CRDT_UPDATE_EVENT_TYPE,
    eventsDefault,
  );

  return selfLevel >= required;
}

/**
 * `canWrite` is a live getter that flips when the homeserver rejects a write,
 * so it is read through a call rather than inline: a direct property read would
 * let the compiler narrow it to its earlier value.
 */
function currentlyWritable(writer: DocumentWriter): boolean {
  return writer.canWrite;
}

async function waitForFlushBounded(
  provider: DocumentWriter,
): Promise<'flushed' | 'timeout' | 'error'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), FLUSH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      provider.waitForFlush().then((): 'flushed' => 'flushed'),
      timeout,
    ]);
  } catch (error) {
    logger.warn(
      `waitForFlush rejected: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 'error';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A write step: `plan` validates and shapes the edit (no mutation), `apply`
 * performs it. Splitting them is what lets the allowlist run — and refuse —
 * before anything is written.
 */
export interface DocumentEditStep<TPlan, TResult> {
  plan: (doc: Y.Doc) => TPlan | EditorFailure;
  apply: (doc: Y.Doc, plan: TPlan) => TResult;
}

/**
 * The one write path. Returns the `apply` step's result on success, or a typed
 * failure — never a partially-reported write.
 */
export async function applyDocumentEdit<TPlan, TResult>(
  session: DocumentSession,
  step: DocumentEditStep<TPlan, TResult>,
): Promise<TResult | EditorFailure> {
  if (session.isFlow) {
    return readOnlyFlow(session.roomId, session.alias);
  }

  if (!currentlyWritable(session.provider)) {
    return needsAccess(
      session.roomId,
      'a previous write to this document was rejected',
    );
  }

  if (!(await canOracleWrite(session))) {
    return needsAccess(
      session.roomId,
      "the assistant's power level in this room is below the write threshold",
    );
  }

  const planned = step.plan(session.doc);
  if (isEditorFailure(planned)) return planned;

  // Fetched before the transaction because reading room state is async and a
  // Yjs transaction must stay synchronous. Skipped entirely once the document
  // has a title, so the extra round-trip is paid at most once per document.
  const titleSeed = readDocumentTitle(session.doc)
    ? undefined
    : await readRoomName(session.matrixClient, session.roomId);

  let result: TResult | undefined;
  session.doc.transact(() => {
    result = step.apply(session.doc, planned);
    if (titleSeed) seedDocumentTitle(session.doc, titleSeed);
  }, EDIT_ORIGIN);

  const flush = await waitForFlushBounded(session.provider);
  if (flush !== 'flushed') {
    return flushTimeout(session.roomId);
  }

  // The homeserver's verdict only arrives with the flush; a rejection here
  // means the mutation exists locally but never reached the room.
  if (!currentlyWritable(session.provider)) {
    return needsAccess(session.roomId, 'the homeserver rejected the write');
  }

  if (result === undefined) {
    return editorError('The edit produced no result.', session.roomId);
  }
  return result;
}

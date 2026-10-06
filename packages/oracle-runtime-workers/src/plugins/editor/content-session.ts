/**
 * Opening a document, and the single choke point every write goes through.
 *
 * `applyDocumentEdit` is the only function in this plugin that mutates a
 * document. It enforces, in this order:
 *
 *   1. a live flow is read-only            → `read_only_flow`
 *   2. an earlier write in this session failed → the same answer as step 6
 *   3. the oracle's power level is below the room's write threshold → `needs_access`
 *   4. the prop allowlist (the caller's `plan` step) → `prop_not_editable` etc.
 *   5. one `doc.transact()` for the whole batch
 *   6. the provider manager's bounded `flush()` **before** success is reported:
 *      a forbidden write → `needs_access`, a definite refusal (413, 401,
 *      400) → `error`, an unacknowledged one → `write_not_saved`
 *
 * Step 6 exists because matrix-crdt writes are fire-and-forget: a Y.Doc
 * mutation always "succeeds" locally, and a homeserver rejection or a failed
 * delivery surfaces only once the batched update is actually sent. Reporting
 * success before the flush is how tools ended up claiming edits that never
 * landed.
 */

import type { MatrixClient } from 'matrix-js-sdk';
import type * as Y from 'yjs';

import { createConsoleLogger } from '../../core/utils';
import {
  EDIT_ORIGIN,
  readDocumentTitle,
  seedDocumentTitle,
} from './document-model';
import {
  editorError,
  isEditorFailure,
  needsAccess,
  readOnlyFlow,
  writeNotSaved,
  writeRefused,
  type EditorFailure,
} from './failures';
import {
  DOC_UPDATE_EVENT_TYPE,
  MatrixProviderManager,
  RoomNotAccessibleError,
  type AppConfig,
  type DocWriteFailure,
} from './provider';

const logger = createConsoleLogger({ module: 'editor-content-session' });

/** Rooms whose canonical alias starts with this hold live flows. */
const FLOW_ALIAS_PREFIX = '#flow-';

/**
 * What the write path needs from the document's provider manager.
 * `MatrixProviderManager` satisfies it; narrowing keeps the guards testable
 * without a Matrix connection.
 */
export interface DocumentWriter {
  /** Why an earlier write did not reach the room, if one did not. */
  readonly writeFailure: DocWriteFailure | undefined;
  /**
   * Wait (bounded by the provider's own deadline and write-retry budget)
   * until every change made so far has been sent; resolves to the failure
   * when one did not land.
   */
  flush(): Promise<DocWriteFailure | undefined>;
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
  writer: DocumentWriter;
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

/** Where a document lives and the client that reaches it. */
export interface DocumentParams {
  matrixClient: MatrixClient;
  appConfig: AppConfig;
}

/** An open document plus the call that releases it. */
export interface OpenedDocument {
  session: DocumentSession;
  dispose: () => Promise<void>;
}

/** Opens a document; a failure to reach it comes back typed, never thrown. */
export type DocumentOpener = (
  params: DocumentParams,
) => Promise<OpenedDocument | EditorFailure>;

/** A thrown open/work error, as the typed failure a tool returns. */
function documentFailure(error: unknown, roomId: string): EditorFailure {
  if (error instanceof RoomNotAccessibleError) {
    return needsAccess(roomId, 'this assistant cannot open the document');
  }
  const detail = error instanceof Error ? error.message : String(error);
  logger.warn(`Failed to open document ${roomId}: ${detail}`);
  return editorError(`Could not open the document: ${detail}`, roomId);
}

/**
 * Open the room's Y.Doc through matrix-crdt. On failure the provider is
 * already disposed; on success the caller owns `dispose`.
 */
export const openDocumentSession: DocumentOpener = async ({
  matrixClient,
  appConfig,
}) => {
  let roomId: string;
  try {
    roomId = await resolveRoomId(matrixClient, appConfig);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return editorError(`Could not resolve the document's room: ${detail}`);
  }

  const manager = new MatrixProviderManager(matrixClient, appConfig);
  try {
    const { doc } = await manager.init();
    const alias = await resolveAlias(matrixClient, appConfig, roomId);
    return {
      session: {
        doc,
        writer: manager,
        matrixClient,
        roomId,
        alias,
        isFlow: isFlowAlias(alias),
      },
      dispose: () => manager.dispose(),
    };
  } catch (error) {
    await manager.dispose();
    return documentFailure(error, roomId);
  }
};

/**
 * How the content tools reach their document. `use` runs `work` against an
 * open session; access problems and thrown errors come back as typed
 * failures so every tool can return them straight to the agent.
 */
export interface DocumentSource {
  use<T>(
    work: (session: DocumentSession) => Promise<T>,
  ): Promise<T | EditorFailure>;
}

/**
 * One document session shared by every tool call until `close()`: opened on
 * the first `use` (so a run that never touches the document never opens it),
 * then reused, so a multi-step task pays the join, history walk and settle
 * delay once. Reads see the live doc; writes still go through
 * `applyDocumentEdit`. A failed open is not remembered — the next `use`
 * tries again. After `close()` every `use` is refused; `close()` waits for
 * calls still running (a write awaiting its flush) before disposing, so a
 * cancelled run never destroys the doc under an in-flight write.
 */
export function sharedDocumentSource(
  params: DocumentParams,
  open: DocumentOpener = openDocumentSession,
): DocumentSource & { close(): Promise<void> } {
  let opening: Promise<OpenedDocument | EditorFailure> | null = null;
  let closed = false;
  const inFlight = new Set<Promise<unknown>>();

  const acquire = (): Promise<OpenedDocument | EditorFailure> => {
    if (opening) return opening;
    const attempt = open(params);
    opening = attempt;
    void attempt.then((result) => {
      if (isEditorFailure(result) && opening === attempt) opening = null;
    });
    return attempt;
  };

  const run = async <T>(
    work: (session: DocumentSession) => Promise<T>,
  ): Promise<T | EditorFailure> => {
    const opened = await acquire();
    if (isEditorFailure(opened)) return opened;
    try {
      return await work(opened.session);
    } catch (error) {
      return documentFailure(error, opened.session.roomId);
    }
  };

  return {
    async use(work) {
      if (closed) return editorError('The document session has ended.');
      const call = run(work);
      inFlight.add(call);
      try {
        return await call;
      } finally {
        inFlight.delete(call);
      }
    },
    async close() {
      closed = true;
      await Promise.allSettled([...inFlight]);
      const pending = opening;
      opening = null;
      if (!pending) return;
      const opened = await pending;
      if (!isEditorFailure(opened)) await opened.dispose();
    },
  };
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
    DOC_UPDATE_EVENT_TYPE,
    eventsDefault,
  );

  return selfLevel >= required;
}

/**
 * The tool result for a write that did not land: the homeserver forbidding it
 * means the assistant lacks access; a definite refusal means nothing was
 * stored; otherwise delivery is uncertain.
 */
function writeFailureResult(
  failure: DocWriteFailure,
  roomId: string,
  forbiddenDetail: string,
): EditorFailure {
  if (failure.kind === 'forbidden') return needsAccess(roomId, forbiddenDetail);
  logger.warn(`Document write to ${roomId} not delivered: ${failure.detail}`);
  return failure.mayHaveLanded
    ? writeNotSaved(roomId, failure.detail)
    : writeRefused(roomId, failure.detail);
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

  // Once a write in this session has failed, the provider refuses every
  // further one, so report that failure instead of attempting another.
  const earlier = session.writer.writeFailure;
  if (earlier) {
    return writeFailureResult(
      earlier,
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

  // The homeserver's verdict only arrives with the flush; a failure here
  // means the mutation exists locally but never reached the room.
  const failure = await session.writer.flush();
  if (failure) {
    return writeFailureResult(
      failure,
      session.roomId,
      'the homeserver rejected the write',
    );
  }

  if (result === undefined) {
    return editorError('The edit produced no result.', session.roomId);
  }
  return result;
}

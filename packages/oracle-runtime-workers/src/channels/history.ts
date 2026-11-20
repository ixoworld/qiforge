/**
 * `POST /channels/history`: the conversations of a web chat binding, read
 * back page by page for a browser that keeps no transcript of its own.
 *
 * A page is built in the person's own object from that object's SQLite
 * alone: the sessions the binding owns (`ChannelTurns.ownedSessions`), their
 * rows read as one conversation (`pageSessionsTranscript`, bounded range
 * reads), and, for each agent message, the run that wrote it when the run is
 * still kept (`ChannelTurns.historyReplies`, by the run's final message id).
 */
import type { ReplyPlan } from '../delivery/types';
import { planTextForModel } from '../delivery/schema';
import {
  isSummarizationMessage,
  pageSessionsTranscript,
  transformTranscript,
  TranscriptCursorError,
  uuidFromString,
  visibleText,
  visibleToUser,
  type AttachmentMeta,
  type SessionMessageCursor,
  type TranscriptRowSource,
} from '../do/transcript';
import type { ThreadMessageRow } from '../sqlite/sqlite-saver';
import {
  CHANNEL_HISTORY_CURSOR_MAX,
  CHANNEL_HISTORY_LIMIT_DEFAULT,
  ChannelError,
  ChannelOrigin,
  type ChannelHistoryInput,
} from './contract';
import {
  CHANNEL_REQUEST_ID_KWARG,
  PERSON_MESSAGE_REQUEST_PREFIX,
} from './replies';
import type { ChannelHistoryReply, ChannelHistoryRun } from './turns';

export type ChannelHistoryItem =
  | {
      kind: 'divider';
      id: string;
      at: string;
      sessionId: string;
    }
  | {
      kind: 'message';
      id: string;
      sessionId: string;
      role: 'user';
      at: string;
      text: string;
      /** The turn's `remoteMessageRef` as the gateway sent it; null when it was not this binding's. */
      remoteRef: string | null;
    }
  | {
      kind: 'message';
      id: string;
      sessionId: string;
      role: 'oracle';
      at: string;
      text: string;
      /** The gateway's request id of the turn whose final message this is; null when unknown. */
      requestId: string | null;
      plan?: { parts: ReplyPlan['parts'] };
    };

export interface ChannelHistoryPage {
  items: ChannelHistoryItem[];
  prevCursor: string | null;
  nextCursor: string | null;
  hasOlder: boolean;
  hasNewer: boolean;
}

/** What a history read needs of the user's object. */
export interface ChannelHistorySource {
  rows: TranscriptRowSource;
  /** The binding's sessions, oldest first (`ChannelTurns.ownedSessions`). */
  ownedSessions(): Promise<{ sessionId: string; createdAt: number }[]>;
  /** Agent message id → its run (`ChannelTurns.historyReplies`). */
  replies(
    sessionId: string,
    messageIds: readonly string[],
  ): Promise<Map<string, ChannelHistoryReply>>;
  /** Request id → its run in this session (`ChannelTurns.historyRuns`). */
  runs(
    sessionId: string,
    requestIds: readonly string[],
  ): Promise<Map<string, ChannelHistoryRun>>;
}

const CURSOR_PREFIX = 'c1.';

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(text: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(
      text.replace(/-/g, '+').replace(/_/g, '/') +
        '='.repeat((4 - (text.length % 4)) % 4),
    );
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      Uint8Array.from(binary, (char) => char.charCodeAt(0)),
    );
  } catch {
    return null;
  }
}

/** An opaque cursor naming one message of one session. */
export function encodeHistoryCursor(cursor: SessionMessageCursor): string {
  return (
    CURSOR_PREFIX +
    base64UrlEncode(JSON.stringify([cursor.sessionId, cursor.messageId]))
  );
}

/**
 * The cursor a page answers with, or null when it would be longer than a
 * query may carry (`CHANNEL_HISTORY_CURSOR_MAX`; ids of today's length are
 * far below it): a cursor the next request could not send is not issued.
 */
function issuedCursor(cursor: SessionMessageCursor | null): string | null {
  if (!cursor) return null;
  const encoded = encodeHistoryCursor(cursor);
  if (encoded.length <= CHANNEL_HISTORY_CURSOR_MAX) return encoded;
  // eslint-disable-next-line no-console -- console IS the logger on Workers (Logs/observability).
  console.warn(
    `[channels] history cursor not issued: ${encoded.length} characters`,
  );
  return null;
}

/** The message a cursor names, or null when it is not one of ours. */
export function decodeHistoryCursor(raw: string): SessionMessageCursor | null {
  if (!raw.startsWith(CURSOR_PREFIX)) return null;
  const json = base64UrlDecode(raw.slice(CURSOR_PREFIX.length));
  if (json === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== 'string' ||
    typeof value[1] !== 'string' ||
    value[0].length === 0 ||
    value[0].length > 255 ||
    value[1].length === 0 ||
    value[1].length > 255
  )
    return null;
  return { sessionId: value[0], messageId: value[1] };
}

function invalidCursor(): ChannelError {
  return new ChannelError(
    400,
    'The history cursor names no message of this chat',
    'invalid_cursor',
  );
}

function iso(at: string | number): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? new Date(0).toISOString()
    : date.toISOString();
}

/** The request id a channel user message recorded (`CHANNEL_REQUEST_ID_KWARG`), if any. */
function requestIdOf(row: ThreadMessageRow): string | undefined {
  const kwargs = row.message.additional_kwargs as
    | Record<string, unknown>
    | undefined;
  const value = kwargs?.[CHANNEL_REQUEST_ID_KWARG];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * One session's rows of a page as history items: what the person sent and
 * what they were answered, oldest first. Tool results, summaries, hidden
 * notes, delivery notices, events and failed replies are left out (the
 * Portal transcript's rules, `transformTranscript`), and so is every input
 * the gateway composed rather than the person (the `connect:` opening): a
 * user message is the person's only when its request id is a person's
 * message id (`wa:`), or, for a message from before request ids were
 * recorded, when the run that answered it was not another kind.
 *
 * An agent message is matched to its run only by the run's recorded final
 * message id; when that run still has the Reply Plan the gateway
 * delivered, the message carries it and the other agent messages of the
 * same run are left out (the plan is what the person received). A run that
 * finished with a plan but no message (a busy line, the files of a failed
 * run) is found through its input's recorded request id and comes as one
 * `run:<runId>` item after that input. An agent message no run names keeps
 * its text and nothing else: a plan is never guessed.
 */
async function segmentItems(
  bindingId: string,
  sessionId: string,
  rows: readonly ThreadMessageRow[],
  source: Pick<ChannelHistorySource, 'replies' | 'runs'>,
): Promise<ChannelHistoryItem[]> {
  const kept = rows.filter((row) => !isSummarizationMessage(row.message));
  // A run starts with its input message (the person's, or a hidden
  // notice or event): the agent messages until the next one are its.
  const runOf = new Map<string, number>();
  const requestOfRun = new Map<number, string>();
  /** Runs whose input this binding sent (its recorded origin names it). */
  const ownRuns = new Set<number>();
  const rowByListedId = new Map<string, ThreadMessageRow>();
  let run = 0;
  for (const row of kept) {
    if (row.message.type === 'human') {
      run += 1;
      const requestId = requestIdOf(row);
      if (requestId) requestOfRun.set(run, requestId);
      const origin = ChannelOrigin.safeParse(
        (
          row.message.additional_kwargs as Record<string, unknown> | undefined
        )?.['org.ixo.qi.origin'],
      );
      if (origin.success && origin.data.binding_id === bindingId)
        ownRuns.add(run);
    }
    runOf.set(row.messageId, run);
    // The id `transformTranscript` lists the message under.
    if (visibleToUser(row.message))
      rowByListedId.set(
        await uuidFromString(row.message.id ?? visibleText(row.message)),
        row,
      );
  }
  const lastRun = run;
  const { messages } = await transformTranscript(
    kept.map((row) => row.message),
  );
  const listed = messages.flatMap((dto) => {
    const row = rowByListedId.get(dto.id);
    return row ? [{ dto, row, run: runOf.get(row.messageId) ?? 0 }] : [];
  });
  const agentIds = listed
    .filter(({ dto }) => dto.type === 'ai')
    .map(({ row }) => row.messageId);
  const matched = agentIds.length
    ? await source.replies(sessionId, agentIds)
    : new Map<string, ChannelHistoryReply>();
  const requestIds = [...new Set(requestOfRun.values())];
  const runs = requestIds.length
    ? await source.runs(sessionId, requestIds)
    : new Map<string, ChannelHistoryRun>();
  const runsWithPlan = new Set<number>();
  const answeredBy = new Map<number, string>();
  for (const { dto, row, run: r } of listed) {
    if (dto.type !== 'ai') continue;
    const reply = matched.get(row.messageId);
    if (reply) answeredBy.set(r, reply.requestId);
    if (reply?.plan) runsWithPlan.add(r);
  }
  /**
   * Whether the input of run `r` is the person's own message on THIS
   * binding: sent through it (its origin names it, so never a Portal message
   * or another binding's turn in the same session) under a person's message
   * id. A message whose request id is not known (written before ids were
   * recorded, its run pruned) is not taken for the person's.
   */
  const personsInput = (r: number): boolean => {
    const requestId = requestOfRun.get(r) ?? answeredBy.get(r);
    return (
      ownRuns.has(r) &&
      requestId !== undefined &&
      requestId.startsWith(PERSON_MESSAGE_REQUEST_PREFIX)
    );
  };
  /** The run of `r` with a reply but no message of its own (a busy line, a failed run's files). */
  const messageless = (r: number): ChannelHistoryRun | undefined => {
    const requestId = requestOfRun.get(r);
    const found = requestId ? runs.get(requestId) : undefined;
    return found?.plan &&
      found.messageId === null &&
      found.plan.parts.length > 0 &&
      !runsWithPlan.has(r)
      ? found
      : undefined;
  };
  // One item per run: a run answered by a plan without a message shows that
  // plan only, never also the partial text it may have left.
  const answeredByPlan = new Set(runsWithPlan);
  for (const r of requestOfRun.keys())
    if (messageless(r)) answeredByPlan.add(r);
  const items: ChannelHistoryItem[] = [];
  /** The reply of run `r` that has no message of its own, if it is kept. */
  const runReply = (r: number): void => {
    const found = messageless(r);
    if (!found?.plan) return;
    items.push({
      kind: 'message',
      id: `run:${found.runId}`,
      sessionId,
      role: 'oracle',
      at: iso(found.at),
      text: planTextForModel(found.plan),
      requestId: found.requestId,
      plan: { parts: found.plan.parts },
    });
  };
  let current = 0;
  const closeRunsBefore = (next: number) => {
    for (; current < next; current += 1) runReply(current);
  };
  for (const { dto, row, run: r } of listed) {
    closeRunsBefore(r);
    const at = iso(dto.createdAt ?? row.anchor.createdAt);
    if (dto.type === 'human') {
      if (!personsInput(r)) continue;
      const files = (
        dto.attachments ?? (dto.attachment ? [dto.attachment] : [])
      )
        .map((file: AttachmentMeta) => `[File sent: ${file.filename}]`)
        .join('\n');
      const text = [dto.content, files].filter(Boolean).join('\n\n');
      if (!text) continue;
      const origin = ChannelOrigin.safeParse(
        dto.metadata?.['org.ixo.qi.origin'],
      );
      items.push({
        kind: 'message',
        id: row.messageId,
        sessionId,
        role: 'user',
        at,
        text,
        remoteRef:
          origin.success && origin.data.binding_id === bindingId
            ? origin.data.remote_ref
            : null,
      });
      continue;
    }
    const reply = matched.get(row.messageId);
    // A reply to this binding's own input, or one of its runs: never a
    // reply to a Portal message or another binding's turn in the session.
    if (!reply && !ownRuns.has(r)) continue;
    const plan = reply?.plan ?? null;
    if (!plan && answeredByPlan.has(r)) continue;
    const text = plan ? planTextForModel(plan) : dto.content;
    if (!text && !plan) continue;
    items.push({
      kind: 'message',
      id: row.messageId,
      sessionId,
      role: 'oracle',
      at,
      text,
      requestId: reply?.requestId ?? null,
      ...(plan ? { plan: { parts: plan.parts } } : {}),
    });
  }
  closeRunsBefore(lastRun + 1);
  return items;
}

/**
 * One page of a web binding's conversations: every session the binding
 * owns, oldest first, read as one conversation and paged by turns; a
 * `divider` before each session except the first, where the page holds
 * that session's start. A binding that owns no session answers an empty
 * page. A cursor that names no message of an owned session is
 * `400 invalid_cursor`.
 */
export async function readChannelHistory(
  input: ChannelHistoryInput,
  source: ChannelHistorySource,
): Promise<ChannelHistoryPage> {
  const decode = (
    raw: string | undefined,
  ): SessionMessageCursor | undefined => {
    if (raw === undefined) return undefined;
    const cursor = decodeHistoryCursor(raw);
    if (!cursor) throw invalidCursor();
    return cursor;
  };
  const before = decode(input.query.before);
  const after = decode(input.query.after);
  const owned = await source.ownedSessions();
  if (owned.length === 0) {
    if (before || after) throw invalidCursor();
    return {
      items: [],
      prevCursor: null,
      nextCursor: null,
      hasOlder: false,
      hasNewer: false,
    };
  }
  const sessionIds = owned.map((session) => session.sessionId);
  const createdAt = new Map(
    owned.map((session) => [session.sessionId, session.createdAt]),
  );
  let page;
  try {
    page = await pageSessionsTranscript(source.rows, sessionIds, {
      limit: input.query.limit ?? CHANNEL_HISTORY_LIMIT_DEFAULT,
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
    });
  } catch (error) {
    if (error instanceof TranscriptCursorError) throw invalidCursor();
    throw error;
  }
  const items: ChannelHistoryItem[] = [];
  for (const segment of page.segments) {
    if (segment.fromStart && segment.sessionId !== sessionIds[0])
      items.push({
        kind: 'divider',
        id: `div:${segment.sessionId}`,
        at: iso(
          createdAt.get(segment.sessionId) ??
            segment.rows[0]?.anchor.createdAt ??
            0,
        ),
        sessionId: segment.sessionId,
      });
    items.push(
      ...(await segmentItems(
        input.bindingId,
        segment.sessionId,
        segment.rows,
        source,
      )),
    );
  }
  return {
    items,
    prevCursor: issuedCursor(page.prev),
    nextCursor: issuedCursor(page.next),
    hasOlder: page.hasOlder,
    hasNewer: page.hasNewer,
  };
}

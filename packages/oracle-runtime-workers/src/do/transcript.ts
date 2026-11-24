import { isDeliveryNoticeMessage, userContent } from '../channels/replies';
/**
 * Transcript → client DTO. Port of `@ixo/common`'s
 * `transformGraphStateMessageToListMessageResponse` so `GET /messages/:id`
 * returns the exact shape the Portal / client SDK already consume.
 */
import type {
  AIMessage,
  BaseMessage,
  ToolMessage,
} from '@langchain/core/messages';
import {
  isAttachmentPlaceholderText,
  isAttachmentViewMessage,
} from '../attachments/retention';
import { SUMMARY_PREFIX } from '../core/middlewares/summarization';
import { ChannelOrigin, ChannelReplyReference } from '../channels/contract';
import { CREATE_ARTIFACT_TOOL, createArtifactParts } from '../artifacts/tool';
import { planText, planTextForModel } from '../delivery/schema';
import { SEND_FILE_TOOL, sentFile } from '../plugins/sandbox/send-file';
import type {
  ThreadMessageAnchor,
  ThreadMessageRow,
} from '../sqlite/sqlite-saver';

export interface ToolCallDto {
  name: string;
  id: string;
  args: unknown;
  status?: 'isRunning' | 'done';
  output?: string;
}

export interface AttachmentMeta {
  filename: string;
  mimetype: string;
  size?: number;
  mxcUri?: string;
  eventId?: string;
  /** A channel file's opaque reference (`channel:<16 hex>`). */
  channelRef?: string;
  category?: string;
}

export interface MessageDto {
  id: string;
  type: 'ai' | 'human';
  content: string;
  toolCalls?: ToolCallDto[];
  reasoning?: string;
  isComplete?: boolean;
  isReasoning?: boolean;
  /**
   * When the message was first saved, ISO 8601: the saver's
   * `additional_kwargs.timestamp`, which is also the listing's order key. The
   * turn's admission time for the user's message; for a reply, the time its
   * step was first checkpointed. Later saves never move it.
   */
  createdAt?: string;
  attachment?: AttachmentMeta;
  attachments?: AttachmentMeta[];
  metadata?: {
    'org.ixo.qi.origin': ChannelOrigin;
    'org.ixo.qi.reply'?: ChannelReplyReference;
  };
}

export interface ListMessagesResponse {
  messages: MessageDto[];
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Stable id for a message without one — sha256 hex of its text (as the Node runtime does). */
export async function uuidFromString(str: string): Promise<string> {
  if (UUID_RE.test(str)) return str;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(str),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function reasoningToText(reasoning: unknown): string | undefined {
  if (typeof reasoning === 'string') return reasoning || undefined;
  if (
    reasoning &&
    typeof reasoning === 'object' &&
    Array.isArray((reasoning as { summary?: unknown }).summary)
  ) {
    const text = (reasoning as { summary: unknown[] }).summary
      .map((part) =>
        part &&
        typeof part === 'object' &&
        typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('');
    return text || undefined;
  }
  return undefined;
}

export function contentToText(content: BaseMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as { text?: unknown }).text;
          // The attachment placeholder is model-facing only; the transcript
          // keeps listing the attachment from its metadata.
          return typeof text === 'string' && !isAttachmentPlaceholderText(text)
            ? text
            : '';
        }
        return '';
      })
      .join('');
  }
  return String(content);
}

/**
 * A stored message's content as a person (or a service acting for one)
 * reads it: a user message loses the "current time" note the model was
 * given with it, when it still starts with exactly the note recorded on it.
 * Every other message is returned as stored.
 */
export function visibleContent(message: BaseMessage): BaseMessage['content'] {
  if (message.type !== 'human') return message.content;
  return userContent(message.content, message.additional_kwargs);
}

/** `visibleContent` as text (titles, mirrors, indexing). */
export function visibleText(message: BaseMessage): string {
  return contentToText(visibleContent(message));
}

/**
 * Whether a stored message is one the user sees in the transcript. System and
 * tool messages never are, nor a failed reply, nor anything the runtime wrote
 * for the model about an attachment: the extracted text of a file (an AI
 * message with an `attachment`) and `view_attachment` re-attaching a payload,
 * nor a chat gateway's delivery notice.
 */
export function visibleToUser(message: BaseMessage): boolean {
  if (message.type === 'system' || message.type === 'tool') return false;
  const kw = (message.additional_kwargs ?? {}) as Record<string, unknown>;
  if (kw.isError) return false;
  if (message.type === 'ai' && Boolean(kw.attachment)) return false;
  // A chat gateway's delivery notice: the model's, never a user message.
  return !isAttachmentViewMessage(message) && !isDeliveryNoticeMessage(message);
}

/**
 * The latest turns as the user saw them, oldest first and each as
 * `user: …` or `assistant: …` cut to `maxChars`, from messages listed newest
 * first. Only what `visibleToUser` lets through, without summaries and rows
 * with no visible text.
 */
export function recentTurnTexts(
  newestFirst: readonly BaseMessage[],
  limit: number,
  maxChars: number,
): string[] {
  const turns: string[] = [];
  for (const message of newestFirst) {
    if (turns.length === limit) break;
    if (isSummarizationMessage(message) || !visibleToUser(message)) continue;
    const text = visibleText(message).trim();
    if (!text) continue;
    const speaker = message.type === 'human' ? 'user' : 'assistant';
    turns.push(`${speaker}: ${text.slice(0, maxChars)}`);
  }
  return turns.reverse();
}

/**
 * The summarization middleware's bookkeeping message — never shown to users.
 * LangChain 1.4 writes it as a HUMAN message tagged
 * `additional_kwargs.lc_source: 'summarization'` whose text starts with the
 * summary prefix; older versions used a system message and other tags. All
 * of them match here, so a condensed thread lists as the kept tail only.
 */
export function isSummarizationMessage(message: BaseMessage): boolean {
  const kw = message.additional_kwargs as Record<string, unknown> | undefined;
  if (
    kw?.lc_source === 'summarization' ||
    kw?.lc_summary_message === true ||
    kw?.summary === true
  )
    return true;
  const text = contentToText(message.content);
  if (text.startsWith(SUMMARY_PREFIX)) return true;
  return message.type === 'system' && /summary of the conversation/i.test(text);
}

export async function transformTranscript(
  messages: BaseMessage[],
): Promise<ListMessagesResponse> {
  const acc: MessageDto[] = [];
  // The first listed reply that made each tool call: a tool result folds
  // into it (looked up, not searched, so long transcripts stay linear).
  const callers = new Map<string, MessageDto>();
  const filesOnly = new Set<MessageDto>();
  for (const message of messages) {
    const toolMsg = message.type === 'tool' ? (message as ToolMessage) : null;
    const kw = (message.additional_kwargs ?? {}) as Record<string, unknown>;

    if (visibleToUser(message)) {
      const reasoning = reasoningToText(kw.reasoning);
      const attachments =
        message.type === 'human'
          ? ((kw.attachments as AttachmentMeta[] | undefined) ??
            (kw.attachment ? [kw.attachment as AttachmentMeta] : undefined))
          : undefined;
      const attachment = attachments?.[0];
      const textContent = visibleText(message);
      const toolCalls = (message as AIMessage).tool_calls;
      const dto: MessageDto = {
        type: message.type === 'ai' ? 'ai' : 'human',
        content: textContent,
        id: await uuidFromString(message.id ?? textContent),
        isComplete: true,
        isReasoning: false,
      };
      if (toolCalls?.length) {
        dto.toolCalls = [];
        for (const tc of toolCalls) {
          dto.toolCalls.push({
            name: tc.name,
            args: tc.args,
            id: tc.id ?? (await uuidFromString(JSON.stringify(tc.args))),
            output: undefined,
          });
        }
      }
      if (reasoning) dto.reasoning = reasoning;
      if (typeof kw.timestamp === 'string' && kw.timestamp.length > 0)
        dto.createdAt = kw.timestamp;
      if (attachment) dto.attachment = attachment;
      if (attachments?.length) dto.attachments = attachments;
      if (message.type === 'human') {
        const origin = ChannelOrigin.safeParse(kw['org.ixo.qi.origin']);
        if (origin.success) {
          const reply = ChannelReplyReference.safeParse(kw['org.ixo.qi.reply']);
          dto.metadata = {
            'org.ixo.qi.origin': origin.data,
            ...(reply.success ? { 'org.ixo.qi.reply': reply.data } : {}),
          };
        }
      }
      acc.push(dto);
      for (const call of dto.toolCalls ?? [])
        if (!callers.has(call.id)) callers.set(call.id, dto);
    }

    if (toolMsg) {
      const kwargs = (
        toolMsg as unknown as {
          lc_kwargs?: { tool_call_id?: string; args?: unknown };
        }
      ).lc_kwargs;
      const toolCallId =
        toolMsg.tool_call_id ??
        kwargs?.tool_call_id ??
        (await uuidFromString(JSON.stringify(kwargs?.args)));
      const el = callers.get(toolCallId);
      if (el) {
        // A chat reply that ended in `create_artifact` wrote no text of its
        // own: list what the user received, the message, link and question.
        const call = el.toolCalls?.find((t) => t.id === toolCallId);
        if (call?.name === CREATE_ARTIFACT_TOOL && !el.content.trim())
          el.content = planText({
            parts: createArtifactParts(
              call.args,
              contentToText(toolMsg.content),
            ),
          });
        // A reply of files alone lists them by name: the link has expired.
        if (
          call?.name === SEND_FILE_TOOL &&
          (filesOnly.has(el) || !el.content.trim())
        ) {
          const sent = sentFile(toolMsg.artifact);
          if (sent) {
            const named = planTextForModel({
              parts: [{ kind: 'file', file: sent.file }],
            });
            el.content = el.content ? `${el.content}\n\n${named}` : named;
            filesOnly.add(el);
          }
        }
        el.toolCalls = el.toolCalls?.map((t) =>
          t.id === toolCallId
            ? {
                ...t,
                output: JSON.stringify(toolMsg.content),
                status: 'done' as const,
              }
            : t,
        );
      }
    }
  }
  return { messages: acc };
}

// ── Transcript paging (docs/plans/transcript-paging.md) ─────────────────────

export const TRANSCRIPT_PAGE_DEFAULT = 20;
export const TRANSCRIPT_PAGE_MAX = 100;
/** Rows read per round while a page collects its turns (a turn is one row or dozens). */
const TRANSCRIPT_ROW_BATCH = 80;

export interface TranscriptPageOptions {
  /** Turns per page: a user message with everything the agent did until the next one. */
  limit: number;
  /** The page of turns older than this cursor (a message id from an earlier page). */
  before?: string;
  /**
   * What follows this cursor, oldest first: the turn the cursor sits in,
   * re-sent whole from its start when the cursor split it, then up to
   * `limit` newer turns. A client folds it in by message id.
   */
  after?: string;
}

export interface TranscriptPage extends ListMessagesResponse {
  /** Continue older from here (`before=`); null once the first message is in the page. */
  prevCursor: string | null;
  /** Continue newer from here (`after=`); null while the thread has no rows. */
  nextCursor: string | null;
  hasOlder: boolean;
  hasNewer: boolean;
}

/** The rows a pager reads — what `SqliteSaver` implements. */
export interface TranscriptRowSource {
  findThreadMessageAnchor(
    threadId: string,
    messageId: string,
  ): Promise<ThreadMessageAnchor | null>;
  listThreadMessageRows(
    threadId: string,
    opts: {
      direction: 'older' | 'newer';
      anchor?: ThreadMessageAnchor | null;
      inclusive?: boolean;
      limit: number;
      /** Only rows of these message types; the others are never decoded. */
      messageTypes?: readonly string[];
    },
  ): Promise<ThreadMessageRow[]>;
}

/** A cursor naming no row of the thread (a client kept one from another session). */
export class TranscriptCursorError extends Error {
  constructor(readonly cursor: string) {
    super(`unknown transcript cursor: ${cursor}`);
    this.name = 'TranscriptCursorError';
  }
}

/**
 * A turn starts at a user message; the summarizer's bookkeeping row is not
 * one, nor is a delivery notice (hidden, so its reply pages with the turn
 * before it, where the Portal shows it).
 */
function startsTurn(row: ThreadMessageRow): boolean {
  return (
    row.message.type === 'human' &&
    !isSummarizationMessage(row.message) &&
    !isDeliveryNoticeMessage(row.message)
  );
}

/** `GET /sessions/:id/messages` query → options, or the 400 to answer with. */
export function parseTranscriptPageQuery(
  query: Record<string, string | undefined>,
):
  | { ok: true; options: TranscriptPageOptions }
  | { ok: false; message: string } {
  const rawLimit = query.limit?.trim();
  let limit = TRANSCRIPT_PAGE_DEFAULT;
  if (rawLimit) {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 1)
      return { ok: false, message: 'limit must be a positive integer' };
    limit = Math.min(n, TRANSCRIPT_PAGE_MAX);
  }
  const before = query.before?.trim() || undefined;
  const after = query.after?.trim() || undefined;
  if (before && after)
    return { ok: false, message: 'before and after are mutually exclusive' };
  return {
    ok: true,
    options: {
      limit,
      ...(before !== undefined && { before }),
      ...(after !== undefined && { after }),
    },
  };
}

async function toPage(rows: ThreadMessageRow[]): Promise<MessageDto[]> {
  const { messages } = await transformTranscript(
    rows.map((r) => r.message).filter((m) => !isSummarizationMessage(m)),
  );
  return messages;
}

/**
 * One page of a session's transcript, aligned to turns so a tool result is
 * never separated from the reply that called it. Without a cursor: the
 * newest `limit` turns. The legacy `GET /messages/:id` listing is this with
 * no limit.
 */
export async function pageThreadTranscript(
  source: TranscriptRowSource,
  threadId: string,
  options: TranscriptPageOptions,
): Promise<TranscriptPage> {
  const limit = Math.max(1, Math.min(options.limit, TRANSCRIPT_PAGE_MAX));
  if (options.after !== undefined)
    return pageNewer(source, threadId, options.after, limit);
  return pageOlder(source, threadId, options.before, limit);
}

async function pageOlder(
  source: TranscriptRowSource,
  threadId: string,
  before: string | undefined,
  limit: number,
): Promise<TranscriptPage> {
  let anchor: ThreadMessageAnchor | null = null;
  if (before !== undefined) {
    anchor = await source.findThreadMessageAnchor(threadId, before);
    if (!anchor) throw new TranscriptCursorError(before);
  }
  const collected: ThreadMessageRow[] = []; // newest first
  let turns = 0;
  let hasOlder = false;
  let cursor = anchor;
  outer: for (;;) {
    const batch = await source.listThreadMessageRows(threadId, {
      direction: 'older',
      anchor: cursor,
      limit: TRANSCRIPT_ROW_BATCH,
    });
    for (let i = 0; i < batch.length; i += 1) {
      const row = batch[i]!;
      collected.push(row);
      if (!startsTurn(row)) continue;
      turns += 1;
      if (turns < limit) continue;
      hasOlder =
        i + 1 < batch.length ||
        (
          await source.listThreadMessageRows(threadId, {
            direction: 'older',
            anchor: row.anchor,
            limit: 1,
          })
        ).length > 0;
      break outer;
    }
    if (batch.length < TRANSCRIPT_ROW_BATCH) break; // the thread's first row is in the page
    cursor = batch[batch.length - 1]!.anchor;
  }
  const rows = collected.reverse();
  return {
    messages: await toPage(rows),
    prevCursor: hasOlder ? rows[0]!.messageId : null,
    nextCursor: rows.length ? rows[rows.length - 1]!.messageId : null,
    hasOlder,
    hasNewer: before !== undefined,
  };
}

// ── Paging across sessions (a channel binding's conversations) ──────────────

/** A message of one session, as a cross-session cursor names it. */
export interface SessionMessageCursor {
  sessionId: string;
  messageId: string;
}

/** The rows one session contributes to a cross-session page, oldest first. */
export interface SessionRowsSegment {
  sessionId: string;
  rows: ThreadMessageRow[];
  /** The segment starts at the session's first row (a divider belongs before it). */
  fromStart: boolean;
}

export interface SessionsTranscriptPage {
  /** Oldest session first; a session with no rows in the page is absent. */
  segments: SessionRowsSegment[];
  /** Continue older from here; null once the oldest session's first row is in the page. */
  prev: SessionMessageCursor | null;
  /** Continue newer from here; null when no session has rows. */
  next: SessionMessageCursor | null;
  hasOlder: boolean;
  hasNewer: boolean;
}

/**
 * One page of several sessions read as one conversation (oldest session
 * first in `sessionIds`), aligned to turns exactly as `pageThreadTranscript`
 * is within one session: without a cursor the newest `limit` turns; `before`
 * the `limit` turns older than a message; `after` what follows a message,
 * the turn the cursor split re-sent from its start. Every read is a bounded
 * range read of one session's person and agent rows (`TRANSCRIPT_ROW_BATCH`
 * at a time; tool and system rows are never read), and a page stops reading
 * once it holds its turns. A cursor whose session is not
 * listed, or whose message the session does not hold, throws
 * `TranscriptCursorError`.
 */
export async function pageSessionsTranscript(
  source: TranscriptRowSource,
  sessionIds: readonly string[],
  options: {
    limit: number;
    before?: SessionMessageCursor;
    after?: SessionMessageCursor;
  },
): Promise<SessionsTranscriptPage> {
  const limit = Math.max(1, Math.min(options.limit, TRANSCRIPT_PAGE_MAX));
  // Only the person's and the agent's rows: tool results and system rows
  // (often the largest) are skipped by SQLite and never decoded.
  const chatRows: TranscriptRowSource = {
    findThreadMessageAnchor: (threadId, messageId) =>
      source.findThreadMessageAnchor(threadId, messageId),
    listThreadMessageRows: (threadId, opts) =>
      source.listThreadMessageRows(threadId, {
        ...opts,
        messageTypes: SESSIONS_ROW_TYPES,
      }),
  };
  if (options.after !== undefined)
    return sessionsNewer(chatRows, sessionIds, options.after, limit);
  return sessionsOlder(chatRows, sessionIds, options.before, limit);
}

/** The message types a cross-session page reads. */
const SESSIONS_ROW_TYPES = ['human', 'ai'] as const;

async function cursorAnchor(
  source: TranscriptRowSource,
  sessionIds: readonly string[],
  cursor: SessionMessageCursor,
): Promise<{ index: number; anchor: ThreadMessageAnchor }> {
  const index = sessionIds.indexOf(cursor.sessionId);
  const anchor =
    index < 0
      ? null
      : await source.findThreadMessageAnchor(
          cursor.sessionId,
          cursor.messageId,
        );
  if (!anchor) throw new TranscriptCursorError(cursor.messageId);
  return { index, anchor };
}

/** Whether a session holds any row older than `anchor` (any row without one). */
async function hasRowsBefore(
  source: TranscriptRowSource,
  sessionId: string,
  anchor: ThreadMessageAnchor | null,
): Promise<boolean> {
  return (
    (
      await source.listThreadMessageRows(sessionId, {
        direction: 'older',
        anchor,
        limit: 1,
      })
    ).length > 0
  );
}

async function sessionsOlder(
  source: TranscriptRowSource,
  sessionIds: readonly string[],
  before: SessionMessageCursor | undefined,
  limit: number,
): Promise<SessionsTranscriptPage> {
  let start = sessionIds.length - 1;
  let startAnchor: ThreadMessageAnchor | null = null;
  if (before !== undefined) {
    const found = await cursorAnchor(source, sessionIds, before);
    start = found.index;
    startAnchor = found.anchor;
  }
  const segments: SessionRowsSegment[] = []; // newest session first
  let turns = 0;
  let full = false;
  let hasOlder = false;
  for (let s = start; s >= 0 && !full; s -= 1) {
    const sessionId = sessionIds[s]!;
    const collected: ThreadMessageRow[] = []; // newest first
    let cursor = s === start ? startAnchor : null;
    let fromStart = false;
    for (;;) {
      const batch = await source.listThreadMessageRows(sessionId, {
        direction: 'older',
        anchor: cursor,
        limit: TRANSCRIPT_ROW_BATCH,
      });
      for (let i = 0; i < batch.length; i += 1) {
        const row = batch[i]!;
        collected.push(row);
        if (!startsTurn(row)) continue;
        turns += 1;
        if (turns < limit) continue;
        full = true;
        const moreHere =
          i + 1 < batch.length ||
          (await hasRowsBefore(source, sessionId, row.anchor));
        fromStart = !moreHere;
        hasOlder = moreHere;
        for (let t = s - 1; t >= 0 && !hasOlder; t -= 1)
          hasOlder = await hasRowsBefore(source, sessionIds[t]!, null);
        break;
      }
      if (full) break;
      if (batch.length < TRANSCRIPT_ROW_BATCH) {
        fromStart = true; // the session's first row is in the page
        break;
      }
      cursor = batch[batch.length - 1]!.anchor;
    }
    if (collected.length)
      segments.push({ sessionId, rows: collected.reverse(), fromStart });
  }
  segments.reverse();
  const oldest = segments[0];
  const newest = segments[segments.length - 1];
  const firstRow = oldest?.rows[0];
  const lastRow = newest?.rows[newest.rows.length - 1];
  return {
    segments,
    prev:
      hasOlder && oldest && firstRow
        ? { sessionId: oldest.sessionId, messageId: firstRow.messageId }
        : null,
    next:
      newest && lastRow
        ? { sessionId: newest.sessionId, messageId: lastRow.messageId }
        : null,
    hasOlder,
    hasNewer: before !== undefined,
  };
}

async function sessionsNewer(
  source: TranscriptRowSource,
  sessionIds: readonly string[],
  after: SessionMessageCursor,
  limit: number,
): Promise<SessionsTranscriptPage> {
  const { index, anchor } = await cursorAnchor(source, sessionIds, after);
  const segments: SessionRowsSegment[] = []; // oldest first
  let turns = 0;
  let hasNewer = false;
  for (let s = index; s < sessionIds.length && !hasNewer; s += 1) {
    const sessionId = sessionIds[s]!;
    const fresh: ThreadMessageRow[] = [];
    let cursor: ThreadMessageAnchor | null = s === index ? anchor : null;
    outer: for (;;) {
      const batch = await source.listThreadMessageRows(sessionId, {
        direction: 'newer',
        anchor: cursor,
        limit: TRANSCRIPT_ROW_BATCH,
      });
      for (const row of batch) {
        if (startsTurn(row)) {
          turns += 1;
          if (turns > limit) {
            hasNewer = true;
            break outer;
          }
        }
        fresh.push(row);
      }
      if (batch.length < TRANSCRIPT_ROW_BATCH) break;
      cursor = batch[batch.length - 1]!.anchor;
    }
    if (fresh.length)
      segments.push({ sessionId, rows: fresh, fromStart: s !== index });
  }
  if (segments.length === 0)
    return {
      segments: [],
      prev: null,
      next: after,
      hasOlder: false,
      hasNewer: false,
    };
  // The cursor split a turn of its own session: re-send that turn from its
  // start, as `pageThreadTranscript` does.
  const first = segments[0]!;
  if (first.sessionId === after.sessionId && !startsTurn(first.rows[0]!)) {
    const head: ThreadMessageRow[] = []; // newest first, the cursor row included
    let back: ThreadMessageAnchor | null = anchor;
    let inclusive = true;
    outer2: for (;;) {
      const batch = await source.listThreadMessageRows(after.sessionId, {
        direction: 'older',
        anchor: back,
        inclusive,
        limit: TRANSCRIPT_ROW_BATCH,
      });
      for (const row of batch) {
        head.push(row);
        if (startsTurn(row)) break outer2;
      }
      if (batch.length < TRANSCRIPT_ROW_BATCH) break;
      back = batch[batch.length - 1]!.anchor;
      inclusive = false;
    }
    first.rows = [...head.reverse(), ...first.rows];
  }
  const newest = segments[segments.length - 1]!;
  return {
    segments,
    prev: null,
    next: {
      sessionId: newest.sessionId,
      messageId: newest.rows[newest.rows.length - 1]!.messageId,
    },
    hasOlder: false,
    hasNewer,
  };
}

async function pageNewer(
  source: TranscriptRowSource,
  threadId: string,
  after: string,
  limit: number,
): Promise<TranscriptPage> {
  const anchor = await source.findThreadMessageAnchor(threadId, after);
  if (!anchor) throw new TranscriptCursorError(after);
  const fresh: ThreadMessageRow[] = []; // oldest first
  let turns = 0;
  let hasNewer = false;
  let cursor: ThreadMessageAnchor = anchor;
  outer: for (;;) {
    const batch = await source.listThreadMessageRows(threadId, {
      direction: 'newer',
      anchor: cursor,
      limit: TRANSCRIPT_ROW_BATCH,
    });
    for (const row of batch) {
      if (startsTurn(row)) {
        turns += 1;
        if (turns > limit) {
          hasNewer = true;
          break outer;
        }
      }
      fresh.push(row);
    }
    if (batch.length < TRANSCRIPT_ROW_BATCH) break;
    cursor = batch[batch.length - 1]!.anchor;
  }
  if (fresh.length === 0)
    return {
      messages: [],
      prevCursor: null,
      nextCursor: after,
      hasOlder: false,
      hasNewer: false,
    };
  // The cursor split a turn (a reply and its tool results land row by row):
  // re-send that turn from its start so the tool results fold into their
  // reply again on the client.
  const head: ThreadMessageRow[] = []; // newest first, the cursor row included
  if (!startsTurn(fresh[0]!)) {
    let back: ThreadMessageAnchor | null = anchor;
    let inclusive = true;
    outer2: for (;;) {
      const batch = await source.listThreadMessageRows(threadId, {
        direction: 'older',
        anchor: back,
        inclusive,
        limit: TRANSCRIPT_ROW_BATCH,
      });
      for (const row of batch) {
        head.push(row);
        if (startsTurn(row)) break outer2;
      }
      if (batch.length < TRANSCRIPT_ROW_BATCH) break;
      back = batch[batch.length - 1]!.anchor;
      inclusive = false;
    }
  }
  const rows = [...head.reverse(), ...fresh];
  return {
    messages: await toPage(rows),
    prevCursor: null,
    nextCursor: rows[rows.length - 1]!.messageId,
    hasOlder: false,
    hasNewer,
  };
}

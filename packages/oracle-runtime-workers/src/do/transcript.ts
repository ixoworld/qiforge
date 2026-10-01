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
  attachment?: AttachmentMeta;
  attachments?: AttachmentMeta[];
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
          // The retention placeholder is model-facing only; the transcript
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
  for (const message of messages) {
    const toolMsg = message.type === 'tool' ? (message as ToolMessage) : null;
    const kw = (message.additional_kwargs ?? {}) as Record<string, unknown>;
    const isExtractionContext = message.type === 'ai' && Boolean(kw.attachment);

    if (
      message.type !== 'system' &&
      message.type !== 'tool' &&
      !kw.isError &&
      !isExtractionContext &&
      // `view_attachment` re-attaching an offloaded payload — model-facing.
      !isAttachmentViewMessage(message)
    ) {
      const reasoning = reasoningToText(kw.reasoning);
      const attachments =
        message.type === 'human'
          ? ((kw.attachments as AttachmentMeta[] | undefined) ??
            (kw.attachment ? [kw.attachment as AttachmentMeta] : undefined))
          : undefined;
      const attachment = attachments?.[0];
      const textContent = contentToText(message.content);
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
      if (attachment) dto.attachment = attachment;
      if (attachments?.length) dto.attachments = attachments;
      acc.push(dto);
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
      const idx = acc.findIndex((m) =>
        m.toolCalls?.some((t) => t.id === toolCallId),
      );
      const el = idx !== -1 ? acc[idx] : undefined;
      if (el) {
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

/** A turn starts at a user message; the summarizer's bookkeeping row is not one. */
function startsTurn(row: ThreadMessageRow): boolean {
  return row.message.type === 'human' && !isSummarizationMessage(row.message);
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

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

/** The summarization middleware's bookkeeping message — never shown to users. */
export function isSummarizationMessage(message: BaseMessage): boolean {
  const kw = message.additional_kwargs as Record<string, unknown> | undefined;
  if (kw?.lc_summary_message === true || kw?.summary === true) return true;
  const text = contentToText(message.content);
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

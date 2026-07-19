import {
  type ToolMessage,
  type AIMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { isUUID } from 'class-validator';
import crypto from 'node:crypto';
import { emojify } from 'node-emoji';

interface ToolCall {
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
  category: string;
}

interface MessageDto {
  id: string;
  type: 'ai' | 'human';
  content: string;
  toolCalls?: ToolCall[];
  reasoning?: string;
  isComplete?: boolean;
  isReasoning?: boolean;
  /** First attachment — kept for clients that only read the singular field. */
  attachment?: AttachmentMeta;
  attachments?: AttachmentMeta[];
}

export interface ListOracleMessagesResponse {
  messages: MessageDto[];
}
export interface CleanAdditionalKwargs {
  msgFromMatrixRoom: boolean;
  timestamp: string;
  oracleName: string;
  reasoning?: string;
  reasoningDetails?: Array<{
    type: string;
    text: string;
  }>;
  attachment?: AttachmentMeta;
  attachments?: AttachmentMeta[];
  [key: string]: unknown; // Allow additional properties for LangChain compatibility
}

/**
 * Flatten message content to display text. Multimodal human messages (native
 * image/file attachments) carry an array of content blocks — only the text
 * blocks are surfaced; base64 data blocks must never reach the client (the
 * attachment chip renders from `attachment` metadata instead).
 */
function contentToText(content: BaseMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .join('');
  }
  return String(content);
}

export function transformGraphStateMessageToListMessageResponse(
  messages: BaseMessage[],
): ListOracleMessagesResponse {
  return {
    messages: messages.reduce<MessageDto[]>((acc, message) => {
      const toolMsg = message.type === 'tool' ? (message as ToolMessage) : null;
      // Synthetic extraction messages (AI-typed, carrying an attachment) are
      // internal model context — the file's extracted text. The file itself
      // renders as a chip from the human message's `attachments`; the raw
      // text dump must not surface as an assistant reply.
      const isExtractionContext =
        message.type === 'ai' &&
        Boolean(
          (message.additional_kwargs as CleanAdditionalKwargs)?.attachment,
        );

      if (
        message.type !== 'system' &&
        message.type !== 'tool' &&
        !message.additional_kwargs?.isError &&
        !isExtractionContext
      ) {
        // Extract reasoning from additional_kwargs
        const additionalKwargs =
          message.additional_kwargs as CleanAdditionalKwargs;
        const reasoning = additionalKwargs?.reasoning;

        // Extract attachment metadata for human messages. Older checkpoints
        // only carry the singular `attachment`; fold it into the array form.
        const attachments =
          message.type === 'human'
            ? (additionalKwargs?.attachments ??
              (additionalKwargs?.attachment
                ? [additionalKwargs.attachment]
                : undefined))
            : undefined;
        const attachment = attachments?.[0];

        const textContent = contentToText(message.content);
        acc.push({
          type: message.type === 'ai' ? 'ai' : 'human',
          content: emojify(textContent),
          id: uuidFromString(message.id ?? textContent),
          toolCalls: (message as AIMessage).tool_calls?.map((toolCall) => ({
            name: toolCall.name,
            args: toolCall.args,
            id: toolCall.id ?? uuidFromString(JSON.stringify(toolCall.args)),
            output: undefined,
          })),
          reasoning,
          isComplete: true, // Messages from DB are always complete
          isReasoning: false, // since this is not a reasoning message and the request is done
          ...(attachment && { attachment }),
          ...(attachments?.length && { attachments }),
        });
      }
      if (toolMsg) {
        const toolCallId =
          toolMsg.lc_kwargs.tool_call_id ??
          uuidFromString(JSON.stringify(toolMsg.lc_kwargs.args));
        const messageWithToolCallIdIdx = acc.findIndex((m) =>
          m.toolCalls?.find((t) => t.id === toolCallId),
        );

        // if the message with the tool call id exits then update the tool Call to add the output
        const el =
          messageWithToolCallIdIdx !== -1
            ? acc[messageWithToolCallIdIdx]
            : null;
        if (el) {
          el.toolCalls = el.toolCalls?.map((t) =>
            t.id === toolCallId
              ? {
                  ...t,
                  output: JSON.stringify(toolMsg.content),
                  status: 'done',
                }
              : t,
          );
          acc[messageWithToolCallIdIdx] = el;
        }
      }

      return acc;
    }, []),
  };
}

export const uuidFromString = (str: string): string => {
  const isStrUUID = isUUID(str);
  if (isStrUUID) return str;
  // generate a uuid from a string
  const hash = crypto.createHash('sha256');
  hash.update(str);
  return hash.digest('hex');
};

/**
 * Channel-memory compaction — the port of the Node runtime's
 * `ChannelMemorySummarizer` (`plugins/matrix-group-chats`). A batch of
 * observed group-room messages becomes one dense summary chunk; the prompts
 * are the Node ones verbatim so both runtimes distil the same memory.
 *
 * Runs in a user object (that is where the platform model's keys live); the
 * gateway, which owns the per-room buffer, asks the speaker's object for the
 * summary (`summarizeGroupMessages`).
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

/** A group-room message as channel memory sees it (the Node `ObservedMessage`). */
export interface ObservedMessage {
  eventId: string;
  threadId: string;
  senderDid: string;
  senderMatrixUserId: string;
  senderDisplayName: string;
  body: string;
  timestamp: number;
}

export const GROUP_SUMMARY_SYSTEM_PROMPT = `You compact a chunk of group-chat messages into a durable, dense summary used as long-term memory for an AI assistant.

KEEP:
- Decisions, agreements, commitments
- Concrete facts (names, dates, numbers, URLs)
- Topics discussed and any unresolved questions
- Member dynamics and stated preferences
- Action items and ownership

DROP:
- Pleasantries, fillers, redundancy
- Transient state (typing, reactions)
- Information that has been explicitly superseded

OUTPUT RULES:
- Output ONLY the summary text. No preamble, no headings, no markdown lists unless they aid clarity.
- Aim for 200-400 tokens.
- Refer to people by their display name.
- Be concrete. Quote short fragments verbatim when wording matters.
- If the messages are mostly chitchat, produce a one-sentence summary noting that.`;

/** Node caps a summary at this many characters. */
export const GROUP_SUMMARY_MAX_CHARS = 6000;

export function formatObservedForPrompt(messages: ObservedMessage[]): string {
  return messages
    .map((m) => {
      const ts = new Date(m.timestamp).toISOString();
      const thread = m.threadId ? ` thread=${m.threadId.slice(0, 10)}` : '';
      return `[${m.senderDisplayName} @ ${ts}${thread}]: ${m.body}`;
    })
    .join('\n');
}

export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          const t = (part as { text?: unknown }).text;
          return typeof t === 'string' ? t : '';
        }
        return '';
      })
      .join('');
  }
  return '';
}

/**
 * Compact a batch of observed messages into a summary. `null` when the model
 * call fails or answers nothing — the caller keeps the batch buffered.
 */
export async function summarizeObservedMessages(
  model: BaseChatModel,
  messages: ObservedMessage[],
  log: Pick<Console, 'warn'> = console,
): Promise<string | null> {
  if (messages.length === 0) return null;
  try {
    const response = await model.invoke([
      new SystemMessage(GROUP_SUMMARY_SYSTEM_PROMPT),
      new HumanMessage(formatObservedForPrompt(messages)),
    ]);
    const text = extractText(response.content).trim();
    if (!text) {
      log.warn(
        `[group-chat] empty summary returned for ${messages.length} messages`,
      );
      return null;
    }
    return text.length > GROUP_SUMMARY_MAX_CHARS
      ? text.slice(0, GROUP_SUMMARY_MAX_CHARS)
      : text;
  } catch (err) {
    log.warn(
      `[group-chat] compaction failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

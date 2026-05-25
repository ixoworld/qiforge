import { Logger } from '@nestjs/common';
import { HumanMessage, SystemMessage } from 'langchain';
import { getProviderChatModel } from '../graph/llm-provider';
import { type ObservedMessage } from './channel-memory.types';

const logger = new Logger('ChannelMemorySummarizer');

const SYSTEM_PROMPT = `You compact a chunk of group-chat messages into a durable, dense summary used as long-term memory for an AI assistant.

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

const formatMessagesForPrompt = (messages: ObservedMessage[]): string =>
  messages
    .map((m) => {
      const ts = new Date(m.timestamp).toISOString();
      const thread = m.threadId ? ` thread=${m.threadId.slice(0, 10)}` : '';
      return `[${m.senderDisplayName} @ ${ts}${thread}]: ${m.body}`;
    })
    .join('\n');

export class ChannelMemorySummarizer {
  /**
   * Compact a batch of observed messages into a summary string.
   * Returns null if the LLM call fails — caller should keep the buffer.
   *
   * Uses the cheapest available model (`session-title` role; falls back to
   * `routing` if needed) since summarization is high-volume and not user-facing.
   */
  async summarize(messages: ObservedMessage[]): Promise<string | null> {
    if (messages.length === 0) return null;

    try {
      const llm = getProviderChatModel('session-title', {
        temperature: 0.2,
        maxTokens: 800,
      } as Parameters<typeof getProviderChatModel>[1]);

      const prompt = formatMessagesForPrompt(messages);
      const response = await llm.invoke([
        new SystemMessage(SYSTEM_PROMPT),
        new HumanMessage(prompt),
      ]);

      const text = extractText(response.content).trim();
      if (!text) {
        logger.warn(
          `[Summarizer] Empty summary returned for ${messages.length} messages`,
        );
        return null;
      }
      // Defensive cap at ~6000 chars (~1500 tokens) in case the model overshoots.
      return text.length > 6000 ? text.slice(0, 6000) : text;
    } catch (err) {
      logger.warn(
        `[Summarizer] Compaction failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}

function extractText(content: unknown): string {
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

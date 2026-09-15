import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import { type AgentMiddleware, summarizationMiddleware } from 'langchain';
import type { Logger } from '../../plugin-api/types';

/**
 * IXO-flavoured prompt instructing the summarizer to preserve identifiers
 * verbatim (DIDs, room IDs, addresses, hashes, URLs, etc.). Replaces the
 * default LangChain summary prompt without changing the wider trigger logic.
 */
const SUMMARY_PROMPT = `<role>
Context Extraction Assistant
</role>

<primary_objective>
Extract the most important context from the conversation history below. This extracted context will REPLACE the full conversation history, so capture everything the agent needs to continue working effectively.
</primary_objective>

<critical_identifiers>
You MUST preserve ALL of the following VERBATIM — copy them exactly as they appear:
- DIDs (decentralized identifiers, e.g. did:ixo:..., did:x:..., did:key:...)
- Matrix Room IDs (e.g. !abc123:matrix.ixo.world)
- Wallet/account addresses (e.g. ixo1..., cosmos1...)
- Session IDs, thread IDs, or checkpoint IDs
- Blockchain transaction hashes or entity IDs
- Any URLs, endpoints, or API paths referenced
- Block IDs (UUIDs) from document editing
Do NOT paraphrase, abbreviate, or omit any of these identifiers.
</critical_identifiers>

<what_to_extract>
1. **Active task**: What is the agent currently working on? What was the user's most recent request?
2. **Key decisions & outcomes**: What has been decided or completed so far?
3. **Pending actions**: What still needs to be done?
4. **Important data**: Any structured data, configurations, or parameters the agent was working with
5. **All identifiers**: Every DID, room ID, address, hash listed above — verbatim
6. **Tool results**: Key outputs from tool calls that inform next steps
7. **Errors or blockers**: Any issues encountered that are still relevant
</what_to_extract>

<format>
Structure the extracted context clearly with sections. Be concise but complete — the agent will lose all context not captured here.
Respond ONLY with the extracted context. No preamble, no explanation.
</format>

<messages>
Messages to summarize:
{messages}
</messages>`;

export const SUMMARY_PREFIX = 'Here is a summary of the conversation to date:';

const DEFAULT_TRIGGER_MESSAGES = 20;
const DEFAULT_TRIGGER_TOKENS = 40_000;
const DEFAULT_KEEP_MESSAGES = 10;

export interface SummarizationMiddlewareOptions {
  /** Model used to generate the summary (typically a small/cheap router model). */
  model: BaseChatModel;
  /**
   * Trigger threshold in messages. Default 20 when no `triggerTokens` is
   * given (the legacy pair); `null` disables the message trigger, which is
   * what a window-derived `triggerTokens` wants (a tool turn is ~4 messages,
   * so 20 fires after five turns whatever the model's window).
   */
  triggerMessages?: number | null;
  /**
   * Trigger on approximate token count (chars/4). Default 40k; the main
   * agent passes a fraction of the model's context window.
   */
  triggerTokens?: number;
  /** Override the number of recent messages to keep (default: 10). */
  keepMessages?: number;
  /** What the summarizer itself may read (tokens); default LangChain's. */
  summaryInputTokens?: number;
  logger?: Pick<Logger, 'warn' | 'log'>;
}

/**
 * LangChain's summarizer swallows a failed summary call and returns
 * `Error generating summary: …` as the summary text — which would then
 * REPLACE the conversation history with an error string (the model's next
 * reply reads "I only received an error in the conversation summary").
 */
const FAILED_SUMMARY = /^Error generating summary:/;

export function isFailedSummary(message: BaseMessage): boolean {
  if (!isSummarizationMessage(message)) return false;
  const { content } = message;
  if (typeof content !== 'string') return false;
  const body = content.startsWith(SUMMARY_PREFIX)
    ? content.slice(SUMMARY_PREFIX.length).trimStart()
    : content;
  return FAILED_SUMMARY.test(body);
}

/**
 * `true` for the condensed-history message the summarization middleware
 * writes into graph state. List endpoints use this to keep it out of the
 * user-visible transcript.
 */
export function isSummarizationMessage(message: BaseMessage): boolean {
  if (message.additional_kwargs?.lc_source === 'summarization') return true;
  const { content } = message;
  return typeof content === 'string' && content.startsWith(SUMMARY_PREFIX);
}

/**
 * Wraps LangChain's built-in `summarizationMiddleware` with the IXO-specific
 * summary prompt + prefix. Pass any compatible chat model — typically the
 * cheap "routing" role.
 */
export const createSummarizationMiddleware = (
  options: SummarizationMiddlewareOptions,
): AgentMiddleware => {
  const triggerMessages =
    options.triggerMessages === null
      ? null
      : (options.triggerMessages ??
        (options.triggerTokens === undefined
          ? DEFAULT_TRIGGER_MESSAGES
          : null));
  const inner = summarizationMiddleware({
    model: options.model,
    summaryPrompt: SUMMARY_PROMPT,
    summaryPrefix: SUMMARY_PREFIX,
    trigger: [
      ...(triggerMessages !== null ? [{ messages: triggerMessages }] : []),
      { tokens: options.triggerTokens ?? DEFAULT_TRIGGER_TOKENS },
    ],
    keep: { messages: options.keepMessages ?? DEFAULT_KEEP_MESSAGES },
    ...(options.summaryInputTokens !== undefined
      ? { trimTokensToSummarize: options.summaryInputTokens }
      : {}),
  });
  const beforeModel = inner.beforeModel;
  if (!beforeModel) return inner;
  // The hook is either a bare handler or `{ hook, canJumpTo }`; keep the shape.
  const handler =
    typeof beforeModel === 'function' ? beforeModel : beforeModel.hook;
  // A summary that failed keeps the history exactly as it was: the turn
  // runs on the full context and the next turn tries again.
  const guarded: typeof handler = async (state, runtime) => {
    const update = await handler(state, runtime);
    const messages =
      update && typeof update === 'object' && 'messages' in update
        ? (update as { messages?: unknown }).messages
        : undefined;
    const failed = Array.isArray(messages)
      ? messages.find((m) => isBaseMessageLike(m) && isFailedSummary(m))
      : undefined;
    if (failed) {
      options.logger?.warn(
        `[summarization] summary failed; keeping the full history this turn: ${String(failed.content).slice(0, 300)}`,
      );
      return undefined;
    }
    if (Array.isArray(messages) && messages.length > 0)
      options.logger?.log(
        `[summarization] condensed the history: ${state.messages.length} messages → a summary + ${messages.length - 2} kept`,
      );
    return update;
  };
  return {
    ...inner,
    beforeModel:
      typeof beforeModel === 'function'
        ? guarded
        : { ...beforeModel, hook: guarded },
  };
};

function isBaseMessageLike(value: unknown): value is BaseMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'content' in value &&
    'additional_kwargs' in value
  );
}

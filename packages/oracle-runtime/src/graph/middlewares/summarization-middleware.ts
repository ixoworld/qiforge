import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { type AgentMiddleware, summarizationMiddleware } from 'langchain';

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

const SUMMARY_PREFIX = 'Here is a summary of the conversation to date:';

const DEFAULT_TRIGGER_MESSAGES = 20;
const DEFAULT_KEEP_MESSAGES = 10;

export interface SummarizationMiddlewareOptions {
  /** Model used to generate the summary (typically a small/cheap router model). */
  model: BaseChatModel;
  /** Override the trigger threshold for messages (default: 20). */
  triggerMessages?: number;
  /** Override the number of recent messages to keep (default: 10). */
  keepMessages?: number;
}

/**
 * Wraps LangChain's built-in `summarizationMiddleware` with the IXO-specific
 * summary prompt + prefix. Pass any compatible chat model — typically the
 * cheap "routing" role.
 */
export const createSummarizationMiddleware = (
  options: SummarizationMiddlewareOptions,
): AgentMiddleware => {
  return summarizationMiddleware({
    model: options.model,
    summaryPrompt: SUMMARY_PROMPT,
    summaryPrefix: SUMMARY_PREFIX,
    trigger: { messages: options.triggerMessages ?? DEFAULT_TRIGGER_MESSAGES },
    keep: { messages: options.keepMessages ?? DEFAULT_KEEP_MESSAGES },
  });
};

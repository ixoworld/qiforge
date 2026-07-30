import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { type AgentMiddleware, createMiddleware } from 'langchain';
import type { Logger } from '../../plugin-api/types.js';

const NOOP_LOGGER: Logger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface ByoHistorySanitizerMiddlewareOptions {
  /** Optional logger; defaults to a no-op. */
  logger?: Logger;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether this turn runs on the user's ChatGPT subscription — the only BYO
 * provider on the Responses API, whose input converter chokes on reasoning
 * kwargs written by other providers. Same narrow-don't-trust context read as
 * the credits middleware.
 */
function isByoChatGptTurn(context: unknown): boolean {
  if (!context || typeof context !== 'object' || !('byo' in context)) {
    return false;
  }
  const { byo } = context;
  return Boolean(
    byo &&
    typeof byo === 'object' &&
    'active' in byo &&
    byo.active === true &&
    'provider' in byo &&
    byo.provider === 'chatgpt',
  );
}

/**
 * Strip `{ type: 'reasoning' }` blocks out of array-shaped assistant
 * content. ChatGPT (Responses API) turns stream thinking summaries as
 * reasoning content blocks that end up in checkpointed state; they are
 * display residue — reasoning continuity rides in
 * `additional_kwargs.reasoning` — and no provider's request converter
 * (including the Responses one) should be fed them back as input. Returns
 * the original array when nothing needs stripping.
 */
function stripReasoningBlocks(
  content: AIMessage['content'],
): AIMessage['content'] {
  if (!Array.isArray(content)) return content;
  const hasReasoningBlock = content.some(
    (block) => isRecord(block) && block.type === 'reasoning',
  );
  if (!hasReasoningBlock) return content;
  const kept = content.filter(
    (block) => !(isRecord(block) && block.type === 'reasoning'),
  );
  return kept.length > 0 ? kept : '';
}

/**
 * Normalize one assistant message's history representation before it is
 * converted into a provider request:
 *
 *   - reasoning content blocks are stripped on every turn (see
 *     {@link stripReasoningBlocks});
 *   - on BYO ChatGPT turns, `additional_kwargs.reasoning` must satisfy the
 *     Responses input converter, which requires `summary` to be an array
 *     whenever a reasoning item is forwarded: a well-formed item passes
 *     through, an item with `encrypted_content` but no `summary` (the shape
 *     this backend streams when summaries aren't requested) gets
 *     `summary: []` so the encrypted reasoning still round-trips, and
 *     anything else (e.g. OpenRouter's reasoning shape from platform turns
 *     earlier in the same thread) is dropped from the outbound copy. Other
 *     providers' converters ignore the kwargs, so they are left alone
 *     off-ChatGPT.
 *
 * Always returns a new message instance on change — checkpointed state is
 * never mutated. Returns the original instance when nothing needs to change.
 */
function sanitizeMessage(
  message: BaseMessage,
  normalizeReasoningKwargs: boolean,
): BaseMessage {
  if (!(message instanceof AIMessage)) return message;

  const content = stripReasoningBlocks(message.content);
  const contentChanged = content !== message.content;

  const reasoning: unknown = message.additional_kwargs?.reasoning;
  let kwargs = message.additional_kwargs;
  let kwargsChanged = false;
  if (
    normalizeReasoningKwargs &&
    reasoning !== undefined &&
    !(isRecord(reasoning) && Array.isArray(reasoning.summary))
  ) {
    const next: Record<string, unknown> = { ...message.additional_kwargs };
    if (
      isRecord(reasoning) &&
      typeof reasoning.encrypted_content === 'string'
    ) {
      next.reasoning = { ...reasoning, summary: [] };
    } else {
      delete next.reasoning;
    }
    kwargs = next;
    kwargsChanged = true;
  }

  if (!contentChanged && !kwargsChanged) return message;

  return new AIMessage({
    content,
    id: message.id,
    name: message.name,
    tool_calls: message.tool_calls,
    invalid_tool_calls: message.invalid_tool_calls,
    usage_metadata: message.usage_metadata,
    response_metadata: message.response_metadata,
    additional_kwargs: kwargs,
  });
}

/**
 * Rewrites the outbound message history so cross-provider residue can't
 * poison a model request. A thread that mixes platform (OpenRouter) turns
 * with BYO ChatGPT (Responses API) turns carries assistant messages whose
 * reasoning payloads only one side understands: foreign reasoning kwargs
 * crash the Responses input converter before the request is sent, and
 * ChatGPT's reasoning content blocks are display residue no provider should
 * be fed back. Block-stripping runs on every turn; kwargs normalization is
 * gated to BYO ChatGPT turns. Untouched messages pass through by reference.
 */
export const createByoHistorySanitizerMiddleware = (
  options?: ByoHistorySanitizerMiddlewareOptions,
): AgentMiddleware => {
  const logger = options?.logger ?? NOOP_LOGGER;

  return createMiddleware({
    name: 'ByoHistorySanitizerMiddleware',
    wrapModelCall: async (request, handler) => {
      const chatGptTurn = isByoChatGptTurn(request.runtime.context);

      let changed = 0;
      const messages = request.messages.map((message) => {
        const sanitized = sanitizeMessage(message, chatGptTurn);
        if (sanitized !== message) changed += 1;
        return sanitized;
      });
      if (changed === 0) {
        return handler(request);
      }

      logger.log(
        `[ByoHistorySanitizer] normalized reasoning history on ${changed} assistant message(s)`,
      );
      return handler({ ...request, messages });
    },
  });
};

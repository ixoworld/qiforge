import 'dotenv/config';

import { ChatAnthropic, type AnthropicInput } from '@langchain/anthropic';
import type { BaseChatModelParams } from '@langchain/core/language_models/chat_models';

export type ChatAnthropicFields = Partial<AnthropicInput> & BaseChatModelParams;

/**
 * Anthropic chat-model factory, mirroring `getChatOpenAiModel`'s shape.
 * `maxTokens` is explicit because the Anthropic Messages API requires it —
 * the library default (2048) truncates long answers.
 */
const getChatAnthropicModel = (params?: ChatAnthropicFields): ChatAnthropic =>
  new ChatAnthropic({
    temperature: 0.2,
    model: 'claude-sonnet-5',
    maxTokens: 8192,
    apiKey: process.env.ANTHROPIC_API_KEY,
    ...params,
  });

export { getChatAnthropicModel };

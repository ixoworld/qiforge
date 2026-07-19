import { Logger } from '@ixo/logger';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { PromptTemplate } from '@langchain/core/prompts';
import z from 'zod';
import {
  getChatOpenAiModel,
  getOpenRouterChatModel,
} from '../models/openai.js';
import { type EnsureKeys } from '../types.js';
import { jsonToYaml } from '../utils/index.js';
import { semanticRouterPrompt } from './semantic-router-prompt.js';
import { validateRoutes } from './validate-routes.js';

/**
 * Creates a semantic router that resolves the path based on the given routes and basedOn value.
 *  routes The routes that will be used to resolve the path
 *  basedOn Array of keys from the state that will be used to resolve the path
 * @returns A function that will be used to resolve the path
 *
 * @example
 * ```typescript
 * const routes = {
 *   generateBlog: 'if the intent is blog',
 *   generateSocialMediaPost: 'if the intent is post',
 * }
 *
 * const intentRouter = createSemanticRouter(routes, ['intent']);
 * ```
 */
export interface CreateSemanticRouterOptions {
  /**
   * Chat model used for classification. When omitted, a provider-aware
   * default is built from `LLM_PROVIDER` — never a raw OpenAI client bound
   * to OpenAI-only environment assumptions.
   */
  chatModel?: BaseChatModel;
}

export const createSemanticRouter = <
  K extends string[],
  R extends Record<string, string> = Record<string, string>,
>(
  routes: R,
  basedOn: K,
  model:
    | 'gpt-4o-mini'
    | 'gpt-4o'
    | 'gpt-4.1-nano'
    | 'gpt-4.1-mini' = 'gpt-4.1-mini',
  isComplex = false,
  options: CreateSemanticRouterOptions = {},
): ((state: EnsureKeys<Record<string, unknown>, K>) => Promise<keyof R>) => {
  // Structured output covers the "complex" double-pass the raw client
  // needed; the flag stays for signature compatibility.
  void isComplex;
  const keys = validateRoutes(routes, basedOn);
  const schema = z.object({
    nextRoute: z.enum(
      keys as [string, ...string[]],
      'The routes that will be used to resolve the path',
    ),
  });

  const resolveChatModel = (): BaseChatModel => {
    if (options.chatModel) return options.chatModel;
    if (process.env.LLM_PROVIDER === 'nebius') {
      return getChatOpenAiModel({ model, temperature: 0 });
    }
    return getOpenRouterChatModel({ model: `openai/${model}`, temperature: 0 });
  };

  return async <T extends Record<string, unknown>>(
    state: EnsureKeys<T, K>,
  ): Promise<keyof R> => {
    const selectedValues = {} as Record<string, string | object>;
    for (const key of basedOn) {
      const stateValue = state[key];
      if (!stateValue) {
        throw new Error(`The state must have a value for the key ${key}`);
      }

      selectedValues[key] = stateValue;
    }
    if (Object.values(selectedValues).length === 0) {
      throw new Error(
        `The state must have a value for the key ${basedOn.toString()}`,
      );
    }

    // find the route that matches the state
    const prompt = PromptTemplate.fromTemplate(semanticRouterPrompt);
    const promptWithState = await prompt.format({
      routes: jsonToYaml(routes),
      state: jsonToYaml(selectedValues),
    });

    const structured = resolveChatModel().withStructuredOutput(schema);
    const parsed = await structured.invoke([
      { role: 'system', content: promptWithState },
      {
        role: 'user',
        content:
          'Think and analyze the routes and messages then select the next route',
      },
    ]);

    Logger.debug(`semantic router selected route: ${parsed.nextRoute}`);
    return parsed.nextRoute;
  };
};

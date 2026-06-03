import { Logger } from '@ixo/logger';
import { PromptTemplate } from '@langchain/core/prompts';
import { OpenAI } from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import z from 'zod';
import { type EnsureKeys } from '../types.js';
import { jsonToYaml } from '../utils/index.js';
import { semanticRouterPrompt } from './semantic-router-prompt.js';
import { validateRoutes } from './validate-routes.js';
import { type APIPromise } from 'openai/index.js';
import { type ParsedChatCompletion } from 'openai/resources/chat/completions.mjs';

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
): ((state: EnsureKeys<Record<string, unknown>, K>) => Promise<keyof R>) => {
  const keys = validateRoutes(routes, basedOn);
  const schema = z.object({
    nextRoute: z.enum(
      keys as [string, ...string[]],
      'The routes that will be used to resolve the path',
    ),
  });
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

    const client = new OpenAI();
    const promptWithState = await prompt.format({
      routes: jsonToYaml(routes),
      state: jsonToYaml(selectedValues),
    });

    const getRoute = async (
      messages: (
        | { role: 'system'; content: string }
        | { role: 'user'; content: string }
      )[],
    ): Promise<
      APIPromise<
        ParsedChatCompletion<{
          nextRoute: string;
        }>
      >
    > => {
      if (model === 'gpt-4.1-nano' && isComplex) {
        const { choices } = await client.chat.completions.create({
          messages,
          model,
        });

        const route = choices[0]?.message?.content?.toString();
        Logger.debug('🚀 ~ route:', route);
        return client.chat.completions.parse({
          model,
          messages,
          response_format: zodResponseFormat(schema, 'routesResponse'),
        });
      }
      return client.chat.completions.parse({
        model,
        messages,
        response_format: zodResponseFormat(schema, 'routesResponse'),
      });
    };

    const completion = await getRoute([
      { role: 'system', content: promptWithState },
      {
        role: 'user',
        content:
          'Think and analyze the routes and messages then select the next route',
      },
    ]);
    const message = completion.choices[0]?.message;

    if (message?.parsed) {
      const nextRoute = message.parsed.nextRoute;
      Logger.debug(
        `🚀 ~ nextRoute: ${message.parsed.nextRoute.toString()}`,
        message.parsed,
      );

      return nextRoute;
    }

    Logger.error('Error parsing the response from the semantic router');
    throw new Error('Error parsing the response from the semantic router');
  };
};

export { zodResponseFormat, type ParsedChatCompletion };

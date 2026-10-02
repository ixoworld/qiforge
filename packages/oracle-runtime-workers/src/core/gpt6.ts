import type { ChatOpenAIFields } from '../plugin-api/types';

const MODELS = new Set([
  'gpt-6-luna',
  'gpt-6-sol',
  'gpt-6.1-sol',
  'gpt-6-astra',
]);

export function isGpt6ModelId(id: unknown): boolean {
  if (typeof id !== 'string') return false;
  return MODELS.has(
    id.replace(/^(openai\/|byo:(openai|chatgpt)\/)/, '').split(':')[0] ?? '',
  );
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

/**
 * The pinned LangChain client recognizes GPT-5 reasoning models only. Supply
 * GPT-6 reasoning through modelKwargs and explicitly select Responses, keeping
 * our checkpoint as the conversation authority rather than provider storage.
 */
export function gpt6ResponseOptions(
  modelId: string,
  params: ChatOpenAIFields = {},
  defaultEffort = 'medium',
): ChatOpenAIFields {
  const kwargs = record(params.modelKwargs);
  const reasoning: Record<string, unknown> = {
    summary: 'auto',
    ...record(params.reasoning),
    ...record(kwargs.reasoning),
  };
  let effort = reasoning.effort ?? defaultEffort;
  if (effort === 'minimal') effort = 'low';
  if (effort === 'none' && !/gpt-6-(luna|sol)(?::|$)/.test(modelId))
    effort = 'low';
  if (
    !['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(effort))
  ) {
    throw new Error('Unsupported GPT-6 reasoning effort');
  }
  const retention =
    params.promptCacheRetention ?? kwargs.prompt_cache_retention;
  for (const key of [
    'temperature',
    'top_p',
    'top_logprobs',
    'logprobs',
    'reasoning_effort',
    'prompt_cache_retention',
    'n',
  ])
    delete kwargs[key];
  const include = Array.isArray(kwargs.include)
    ? kwargs.include.filter(
        (item): item is string =>
          typeof item === 'string' && item !== 'message.output_text.logprobs',
      )
    : [];
  return {
    ...params,
    useResponsesApi: true,
    zdrEnabled: true,
    temperature: undefined,
    topP: undefined,
    logprobs: undefined,
    topLogprobs: undefined,
    promptCacheRetention: undefined,
    reasoning: undefined,
    modelKwargs: {
      ...kwargs,
      ...(retention !== undefined
        ? { prompt_cache_options: { ttl: '30m' } }
        : {}),
      reasoning: { ...reasoning, effort },
      store: false,
      include: [...new Set([...include, 'reasoning.encrypted_content'])],
    },
  };
}

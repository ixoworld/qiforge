/**
 * Local-testing hook for the error path. Sending a chat message of the form
 *
 *   /simulate-error <preset>
 *
 * makes the turn fail with a realistic provider error (same shape the SDK
 * stack actually throws — status/code/nested error/message all faithful to
 * the real thing) so the classifier → SSE → client-UI chain can be exercised
 * without burning real credentials or quota. `fallback` presets emit the
 * BYO→platform degradation notice and let the turn continue normally.
 *
 * Active ONLY when the env var `ALLOW_ERROR_SIMULATION` is exactly `true` —
 * never set it in a deployed environment.
 */

import { type ByoProvider } from '../../llm/byo-catalog.js';
import {
  buildByoFallbackNotice,
  type ByoFallbackNoticePayload,
} from '../../llm/provider-error.js';

const TRIGGER_PREFIX = '/simulate-error';

interface SimulatedErrorSpec {
  message: string;
  status?: number;
  code?: string;
  nested?: { type: string; message: string };
  byoProvider?: ByoProvider;
}

/**
 * Presets replicate real captured error shapes:
 *  - OpenAI/DeepSeek/Gemini errors carry `status` + a "NNN ..." message (and
 *    `code: 'insufficient_quota'` for billing exhaustion).
 *  - Anthropic errors carry `status` + `error.type` (`rate_limit_error`,
 *    `authentication_error`, ...) with the JSON blob in the message.
 *  - The ChatGPT backend reports errors with an EMPTY body, so all the SDK
 *    can say is "NNN status code (no body)".
 */
const PRESETS: Record<string, SimulatedErrorSpec> = {
  'openai:billing': {
    status: 429,
    code: 'insufficient_quota',
    message:
      '429 You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.',
    byoProvider: 'openai',
  },
  'openai:rate_limit': {
    status: 429,
    code: 'rate_limit_exceeded',
    message:
      '429 Rate limit reached for gpt-5.2 in organization org-simulated on tokens per min (TPM): Limit 30000, Used 30000, Requested 460.',
    byoProvider: 'openai',
  },
  'openai:auth': {
    status: 401,
    code: 'invalid_api_key',
    message:
      '401 Incorrect API key provided: sk-proj-***simulated. You can find your API key at https://platform.openai.com/account/api-keys.',
    byoProvider: 'openai',
  },
  'anthropic:billing': {
    status: 400,
    nested: {
      type: 'invalid_request_error',
      message:
        'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
    },
    message:
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}',
    byoProvider: 'anthropic',
  },
  'anthropic:rate_limit': {
    status: 429,
    nested: {
      type: 'rate_limit_error',
      message:
        'Number of request tokens has exceeded your per-minute rate limit.',
    },
    message:
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit."}}',
    byoProvider: 'anthropic',
  },
  'anthropic:auth': {
    status: 401,
    nested: { type: 'authentication_error', message: 'invalid x-api-key' },
    message:
      '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    byoProvider: 'anthropic',
  },
  'deepseek:billing': {
    status: 402,
    message: '402 Insufficient Balance',
    byoProvider: 'deepseek',
  },
  'gemini:rate_limit': {
    status: 429,
    message:
      '429 You exceeded your current quota, please check your plan and billing details. [reason: "RESOURCE_EXHAUSTED"]',
    byoProvider: 'gemini',
  },
  'chatgpt:usage_limit': {
    status: 429,
    message: '429 status code (no body)',
    byoProvider: 'chatgpt',
  },
  'chatgpt:auth': {
    status: 401,
    message: '401 status code (no body)',
    byoProvider: 'chatgpt',
  },
  server: {
    status: 529,
    nested: { type: 'overloaded_error', message: 'Overloaded' },
    message:
      '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  },
  timeout: { message: 'Request timed out.' },
  network: { message: 'fetch failed' },
  unknown: { message: 'Simulated unclassifiable failure.' },
};

export type SimulationDirective =
  | { action: 'throw'; error: Error; byoProvider?: ByoProvider }
  | { action: 'notice'; payload: ByoFallbackNoticePayload };

function buildSimulatedError(spec: SimulatedErrorSpec): Error {
  const error = new Error(spec.message);
  error.name = 'SimulatedProviderError';
  Object.assign(error, {
    ...(spec.status !== undefined && { status: spec.status }),
    ...(spec.code !== undefined && { code: spec.code }),
    ...(spec.nested !== undefined && { error: spec.nested }),
  });
  return error;
}

/**
 * Inspect a chat message for the simulation trigger. Returns `null` when
 * simulation is disabled, the message is not a trigger, or the preset is
 * unknown (an unknown preset throws a descriptive error listing the presets
 * so the tester sees what's available instead of a silent normal turn).
 */
export function resolveErrorSimulation(
  message: string | undefined,
): SimulationDirective | null {
  if (process.env.ALLOW_ERROR_SIMULATION !== 'true') return null;
  const trimmed = message?.trim() ?? '';
  if (!trimmed.startsWith(TRIGGER_PREFIX)) return null;

  const preset = trimmed.slice(TRIGGER_PREFIX.length).trim() || 'unknown';

  if (preset === 'fallback' || preset === 'fallback:reconnect') {
    return {
      action: 'notice',
      payload: buildByoFallbackNotice('reconnect_required', 'chatgpt'),
    };
  }
  if (preset === 'fallback:not_connected') {
    return {
      action: 'notice',
      payload: buildByoFallbackNotice('not_connected', 'anthropic'),
    };
  }

  const spec = PRESETS[preset];
  if (!spec) {
    return {
      action: 'throw',
      error: new Error(
        `Unknown simulation preset "${preset}". Available: ${[...Object.keys(PRESETS), 'fallback', 'fallback:not_connected'].join(', ')}`,
      ),
    };
  }
  return {
    action: 'throw',
    error: buildSimulatedError(spec),
    ...(spec.byoProvider && { byoProvider: spec.byoProvider }),
  };
}

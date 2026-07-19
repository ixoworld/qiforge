import type { ModelPolicyInput } from './model-policy.js';

/**
 * The built-in model policy — the former hard-coded provider table restated
 * as DATA, selected per `LLM_PROVIDER`. It is layer 0: `MODEL_POLICY_JSON`
 * and the host's `modelPolicy` option override any of it without a
 * framework release, which is the point.
 *
 * The `main` fallback chain on OpenRouter preserves long-standing behavior
 * and is itself policy: each entry carries its disclosure, and an operator
 * silences it with `fallbacks: { main: [] }` in any higher layer.
 */
export function builtinModelPolicy(
  provider: 'openrouter' | 'nebius' | string,
): ModelPolicyInput {
  if (provider === 'nebius') {
    return {
      defaultProvider: 'nebius',
      roles: {
        main: {
          model: 'Qwen/Qwen3-235B-A22B-Thinking-2507',
          credentialRef: 'nebius-default',
        },
        skills: {
          model: 'Qwen/Qwen3-235B-A22B-Thinking-2507',
          credentialRef: 'nebius-default',
        },
        subagent: {
          model: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
          credentialRef: 'nebius-default',
        },
        vision: {
          model: 'Qwen/Qwen2.5-VL-72B-Instruct',
          credentialRef: 'nebius-default',
        },
        guard: {
          model: 'meta-llama/Llama-Guard-3-8B',
          credentialRef: 'nebius-default',
        },
        routing: {
          model: 'Qwen/Qwen3-30B-A3B-Instruct-2507',
          credentialRef: 'nebius-default',
        },
        'session-title': {
          model: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
          credentialRef: 'nebius-default',
        },
        embedding: {
          model: 'Qwen/Qwen3-Embedding-8B',
          credentialRef: 'nebius-default',
        },
      },
    };
  }

  return {
    defaultProvider: 'openrouter',
    roles: {
      main: {
        model: 'z-ai/glm-5.2:nitro',
        credentialRef: 'openrouter-default',
      },
      skills: {
        model: 'z-ai/glm-5.2:nitro',
        credentialRef: 'openrouter-default',
      },
      subagent: {
        model: 'z-ai/glm-5.2:nitro',
        credentialRef: 'openrouter-default',
      },
      vision: {
        model: 'google/gemini-2.5-flash-lite',
        credentialRef: 'openrouter-default',
      },
      guard: {
        model: 'meta-llama/llama-3.1-8b-instruct',
        credentialRef: 'openrouter-default',
      },
      routing: {
        model: 'openai/gpt-oss-20b',
        credentialRef: 'openrouter-default',
      },
      custom_low: {
        model: 'openai/gpt-oss-120b',
        credentialRef: 'openrouter-default',
      },
      custom_medium: {
        model: 'moonshotai/kimi-k2-thinking',
        credentialRef: 'openrouter-default',
      },
      'session-title': {
        model: 'meta-llama/llama-3.1-8b-instruct',
        credentialRef: 'openrouter-default',
      },
      embedding: {
        model: 'text-embedding-3-small',
        credentialRef: 'openrouter-default',
      },
    },
    fallbacks: {
      main: [
        {
          model: 'qwen/qwen3-235b-a22b-thinking-2507',
          disclosure: {
            reason: 'primary main model unavailable — latency-sorted fallback',
            costChange: 'provider list pricing of the fallback model applies',
          },
        },
        {
          model: 'google/gemini-2.5-flash-lite',
          disclosure: {
            reason: 'primary main model unavailable — latency-sorted fallback',
            residencyChange: 'served by Google infrastructure',
            costChange: 'provider list pricing of the fallback model applies',
          },
        },
      ],
    },
    constraints: {
      // The fallback chain's models must sit inside the allowed set; list
      // them alongside the declared role targets.
      allowedModels: [
        'z-ai/glm-5.2:nitro',
        'google/gemini-2.5-flash-lite',
        'meta-llama/llama-3.1-8b-instruct',
        'openai/gpt-oss-20b',
        'openai/gpt-oss-120b',
        'moonshotai/kimi-k2-thinking',
        'text-embedding-3-small',
        'qwen/qwen3-235b-a22b-thinking-2507',
      ],
    },
  };
}

import type { CodexAuthMode, CodexCapabilities } from './provider.js';

/**
 * Resolve what an auth mode permits.
 *
 * The `directModelApi: false` on the subscription path is the load-bearing
 * distinction: a ChatGPT plan authorises the Codex runtime, not token-billed
 * OpenAI API access. Code that needs the raw API must check this flag rather
 * than assume the presence of credentials implies API entitlement.
 */
export function resolveCodexCapabilities(
  mode: CodexAuthMode,
): CodexCapabilities {
  if (mode === 'chatgpt_subscription') {
    return {
      runtimeThreads: true,
      directModelApi: false,
      billing: 'subscription',
      // The plan decides which models are reachable; forcing an override
      // produces an opaque upstream rejection rather than a useful error.
      modelOverride: false,
    };
  }
  return {
    runtimeThreads: true,
    directModelApi: true,
    billing: 'usage_based',
    modelOverride: true,
  };
}

/** One-line explanation of the active mode, for settings help text. */
export function describeCodexAuthMode(mode: CodexAuthMode): string {
  return mode === 'chatgpt_subscription'
    ? 'Use ChatGPT sign-in for Codex subscription access. Your plan covers Codex runtime usage; it does not grant direct OpenAI API access.'
    : 'Use an API key for usage-based OpenAI access. Turns are billed per token against the key.';
}

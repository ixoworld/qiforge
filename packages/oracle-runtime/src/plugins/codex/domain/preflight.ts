import { resolveCodexCapabilities } from './capabilities.js';
import {
  assertToolPolicy,
  normalizeCodexConfig,
  CodexConfigError,
  type CodexNormalizedConfig,
} from './config.js';
import type { CodexAuthMode, CodexCapabilities } from './provider.js';

/** Everything the runtime needs, validated. Produced only by `preflight`. */
export interface CodexRuntimePlan {
  readonly config: CodexNormalizedConfig;
  readonly authMode: CodexAuthMode;
  readonly capabilities: CodexCapabilities;
}

/**
 * The single gate every runtime start passes through: config schema →
 * auth-mode validation → capability resolution → tool policy. Nothing
 * downstream re-derives these; they take the plan.
 */
export function preflight(
  rawConfig: unknown,
  options: { requestedAuthMode?: string } = {},
): CodexRuntimePlan {
  const config = normalizeCodexConfig(rawConfig);

  // A caller-supplied mode must match the configured one. Silent fallback
  // between subscription and API-key billing is never acceptable — an
  // operator changes the mode deliberately, through `setAuthMode`.
  if (
    options.requestedAuthMode !== undefined &&
    options.requestedAuthMode !== config.authMode
  ) {
    throw new CodexConfigError(
      `requested auth mode '${options.requestedAuthMode}' does not match the configured mode '${config.authMode}'. Change the mode explicitly rather than relying on a fallback.`,
    );
  }

  assertToolPolicy(config);

  return {
    config,
    authMode: config.authMode,
    capabilities: resolveCodexCapabilities(config.authMode),
  };
}

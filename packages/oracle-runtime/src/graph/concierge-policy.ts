import type {
  RegisteredSubAgent,
  RegisteredTool,
} from '../registries/index.js';

/**
 * Plugins whose tools stay bound on a concierge turn. The concierge plugin
 * is the front-desk surface itself (oracle info/FAQ, domain docs, support
 * escalation, artefact sharing, authorization request).
 */
const CONCIERGE_TOOL_PLUGINS = new Set(['concierge']);

/**
 * Plugins whose sub-agents stay bound on a concierge turn. The domain
 * indexer answers "who/what is this entity" questions from public chain
 * data — exactly the concierge's domain-scoped remit — and its manifest is
 * `visibility: 'always'`, so the capability gate passes it without the
 * (dropped) `load_capability` meta-tool.
 */
const CONCIERGE_SUBAGENT_PLUGINS = new Set(['domain-indexer']);

export interface ConciergePolicyInput {
  allTools: RegisteredTool[];
  allSubAgents: RegisteredSubAgent[];
}

/**
 * Restrict the tool surface for a concierge (unauthorized-visitor) turn.
 * Everything outside the concierge allowlist is dropped BEFORE binding, so
 * an anonymous Matrix sender can never reach sandbox/composio/memory-write
 * or any other full-service capability — and can't burn credits through
 * them. Meta-tools are dropped separately by the caller (no
 * `load_capability` escape hatch).
 */
export function applyConciergePolicy({
  allTools,
  allSubAgents,
}: ConciergePolicyInput): {
  tools: RegisteredTool[];
  subAgents: RegisteredSubAgent[];
} {
  return {
    tools: allTools.filter((entry) =>
      CONCIERGE_TOOL_PLUGINS.has(entry.pluginName),
    ),
    subAgents: allSubAgents.filter((entry) =>
      CONCIERGE_SUBAGENT_PLUGINS.has(entry.pluginName),
    ),
  };
}

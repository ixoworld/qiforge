import type { StructuredTool } from 'langchain';
import type {
  PluginContext,
  PluginSubAgent,
  PluginTool,
  RuntimeContext,
} from '../plugin-api/types.js';
import type { SubAgentRegistry } from '../registries/subagent-registry.js';
import type { AmbientServices } from '../runtime-context/ambient.js';
import type { RuntimeStateInput } from '../runtime-context/build-runtime.js';
import { createSubagentAsTool, type AgentSpec } from './subagent-as-tool.js';

/** Inputs for collecting and wrapping sub-agents. */
export interface CollectSubAgentsInput {
  registry: SubAgentRegistry;
  buildCtx: PluginContext;
  ambient: AmbientServices;
  /** Snapshot of state used when handlers need to build a `RuntimeContext`. */
  state: RuntimeStateInput;
  /** User DID — used for thread-scoped checkpointing. */
  userDid: string;
  /** Session ID — used for thread/run scoping. */
  sessionId: string;
  /**
   * Optional adaptor turning a `PluginSubAgent` into the `AgentSpec` shape
   * understood by `createSubagentAsTool`. Default uses a permissive bridge
   * that materialises the plugin's tools list (when an array, not a function)
   * into the spec.
   */
  toAgentSpec?: (subAgent: PluginSubAgent, buildCtx: PluginContext) => AgentSpec;
}

const NOOP_HANDLER = async () => '';

/**
 * Default adaptor — turns a `PluginSubAgent` into the `AgentSpec` shape
 * required by `createSubagentAsTool`.
 *
 * Plugin sub-agent tools are `PluginTool[]` with `(args, ctx)` handlers; the
 * sub-agent runs them inside its own `createAgent` call where LangChain
 * supplies a `runConfig`, not a `RuntimeContext`. For now we just project the
 * names, descriptions, and schemas as `StructuredTool`s — full wrapping for
 * sub-agent-internal tool calls will land alongside the bundled plugins
 * that actually own them.
 */
function defaultToAgentSpec(
  subAgent: PluginSubAgent,
  buildCtx: PluginContext,
  userDid: string,
  sessionId: string,
): AgentSpec {
  const systemPrompt =
    typeof subAgent.systemPrompt === 'function'
      ? subAgent.systemPrompt(buildCtx)
      : subAgent.systemPrompt;

  const pluginTools: PluginTool[] = Array.isArray(subAgent.tools)
    ? subAgent.tools
    : subAgent.tools(buildCtx);

  const tools: StructuredTool[] = pluginTools.map((t) =>
    // Minimal pass-through; sub-agent-internal tools are exercised by their
    // owning plugins directly. We keep the descriptor shape so the agent-side
    // schema is stable.
    ({
      name: t.name,
      description: t.description,
      schema: t.schema,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      invoke: NOOP_HANDLER as any,
    }) as unknown as StructuredTool,
  );

  return {
    name: subAgent.name,
    description: subAgent.description,
    systemPrompt,
    tools,
    middleware: subAgent.middlewares,
    userDid,
    sessionId,
  };
}

/**
 * Collect sub-agents from the registry and wrap each as a LangChain tool
 * using `createSubagentAsTool`. A failure inside any one sub-agent's
 * conversion logs via `ambient.logger` and is dropped from the list — the
 * graph still builds with the others, matching apps/app's `Promise.allSettled`
 * pattern.
 */
export async function collectSubAgentsWithFallback(
  input: CollectSubAgentsInput,
): Promise<StructuredTool[]> {
  const { registry, buildCtx, ambient, userDid, sessionId, toAgentSpec } =
    input;

  const entries = registry.collect(buildCtx);

  const results = await Promise.allSettled(
    entries.map(async ({ pluginName, subAgent }) => {
      try {
        const spec = toAgentSpec
          ? toAgentSpec(subAgent, buildCtx)
          : defaultToAgentSpec(subAgent, buildCtx, userDid, sessionId);
        return createSubagentAsTool(spec);
      } catch (err) {
        ambient.logger.error(
          { pluginName, err: err instanceof Error ? err.message : String(err) },
          'sub-agent init failed; skipping',
        );
        return null;
      }
    }),
  );

  return results.flatMap((r) =>
    r.status === 'fulfilled' && r.value ? [r.value] : [],
  );
}

// Re-export so callers don't need to import the inner module directly.
export type { RuntimeContext };

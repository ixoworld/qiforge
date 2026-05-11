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
import { wrapPluginTool } from './wrap-plugin-tool.js';

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
   * Optional per-request runtime context. Plumbed through to
   * `SubAgentRegistry.collect` so plugins implementing `getRequestSubAgents`
   * can branch on live state (e.g. AG-UI actions).
   */
  rtCtx?: RuntimeContext;
  /**
   * Optional adaptor turning a `PluginSubAgent` into the `AgentSpec` shape
   * understood by `createSubagentAsTool`. Default wraps each `PluginTool`
   * via `wrapPluginTool` so its handler receives a real `RuntimeContext`,
   * and resolves the sub-agent's `model` role via `ambient.llm.get(...)`.
   */
  toAgentSpec?: (
    subAgent: PluginSubAgent,
    buildCtx: PluginContext,
    ambient: AmbientServices,
    state: RuntimeStateInput,
  ) => AgentSpec;
  /**
   * Tools the runtime wants every sub-agent to be able to call (e.g. the
   * non-destructive memory CRUD tools the memory plugin contributes to the
   * main agent). Appended to each sub-agent's own tool list when the inner
   * `createAgent` is built — the sub-agent's tools take precedence in name
   * collisions.
   */
  passthroughTools?: StructuredTool[];
}

/**
 * Default adaptor — turns a `PluginSubAgent` into the `AgentSpec` shape
 * required by `createSubagentAsTool`.
 *
 * Plugin sub-agent tools are `PluginTool[]` with `(args, ctx)` handlers; the
 * sub-agent runs them inside its own `createAgent` call where LangChain
 * supplies a `ToolRuntime`, not a `RuntimeContext`. Each tool is wrapped via
 * `wrapPluginTool` so its handler observes a fully-built `RuntimeContext`
 * (same bridge the main agent uses).
 *
 * The sub-agent's `model` role (default `'subagent'`) is resolved via the
 * ambient LLM adapter and propagated to `AgentSpec.model` so the wrapping
 * `createSubagentAsTool` can actually run a `createAgent` instead of
 * returning the "no model configured" error path.
 */
function defaultToAgentSpec(
  subAgent: PluginSubAgent,
  buildCtx: PluginContext,
  ambient: AmbientServices,
  state: RuntimeStateInput,
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
    wrapPluginTool(t, { ambient, state }),
  );

  const model = ambient.llm.get(subAgent.model ?? 'subagent');

  return {
    name: subAgent.name,
    description: subAgent.description,
    systemPrompt,
    tools,
    model,
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
  const {
    registry,
    buildCtx,
    ambient,
    state,
    userDid,
    sessionId,
    rtCtx,
    toAgentSpec,
    passthroughTools,
  } = input;

  const entries = await registry.collect(buildCtx, rtCtx);

  const results = await Promise.allSettled(
    entries.map(async ({ pluginName, subAgent }) => {
      try {
        const spec = toAgentSpec
          ? toAgentSpec(subAgent, buildCtx, ambient, state)
          : defaultToAgentSpec(
              subAgent,
              buildCtx,
              ambient,
              state,
              userDid,
              sessionId,
            );
        const withPassthrough: AgentSpec = passthroughTools?.length
          ? { ...spec, passthroughTools }
          : spec;
        return createSubagentAsTool(withPassthrough);
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

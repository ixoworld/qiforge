import type { ToolExecutionContext } from './tool-execution';
import type { StructuredTool } from 'langchain';
import type {
  PluginContext,
  PluginSubAgent,
  PluginTool,
  RuntimeContext,
  SharedAccessors,
} from '../plugin-api/types';
import type { RegisteredSubAgent, SubAgentRegistry } from './registries';
import type {
  AmbientServices,
  RunConfigContext,
  RuntimeStateInput,
} from './runtime-context';
import { createSubagentAsTool, type AgentSpec } from './subagent-as-tool';
import { wrapPluginTool } from './wrap-plugin-tool';

/** Inputs for collecting and wrapping sub-agents. */
export interface CollectSubAgentsInput {
  registry: SubAgentRegistry;
  execution?: ToolExecutionContext;
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
   * can branch on live state.
   */
  rtCtx?: RuntimeContext;
  /** `ctx.shared` factory forwarded to every wrapped sub-agent tool. */
  sharedFactory?: (ctx: RuntimeContext) => SharedAccessors;
  /** Request context forwarded to every wrapped sub-agent tool (see `wrapPluginTool`). */
  fallbackContext?: RunConfigContext;
  /**
   * Optional adaptor turning a `PluginSubAgent` into the `AgentSpec` shape
   * understood by `createSubagentAsTool`. Default wraps each `PluginTool`
   * via `wrapPluginTool` and resolves the sub-agent's `model` role via
   * `ambient.llm.get(...)`.
   */
  toAgentSpec?: (
    subAgent: PluginSubAgent,
    buildCtx: PluginContext,
    ambient: AmbientServices,
    state: RuntimeStateInput,
  ) => AgentSpec;
  /**
   * Tools the runtime wants every sub-agent to be able to call. Appended to
   * each sub-agent's own tool list — the sub-agent's tools take precedence
   * in name collisions.
   */
  passthroughTools?: StructuredTool[];
  /**
   * Optional pre-collected sub-agent list. When provided, the registry is not
   * queried — callers that need to filter the entries collect from the
   * registry themselves, apply the filter, and pass the result here.
   */
  subAgents?: RegisteredSubAgent[];
}

/**
 * Default adaptor — turns a `PluginSubAgent` into the `AgentSpec` shape
 * required by `createSubagentAsTool`. Each plugin tool is wrapped via
 * `wrapPluginTool` so its handler observes a fully-built `RuntimeContext`
 * (same bridge the main agent uses); the sub-agent's `model` role (default
 * `'subagent'`) is resolved via the ambient LLM adapter.
 */
function defaultToAgentSpec(
  subAgent: PluginSubAgent,
  buildCtx: PluginContext,
  ambient: AmbientServices,
  state: RuntimeStateInput,
  userDid: string,
  sessionId: string,
  sharedFactory: ((ctx: RuntimeContext) => SharedAccessors) | undefined,
  fallbackContext: RunConfigContext | undefined,
  execution?: ToolExecutionContext,
): AgentSpec {
  const systemPrompt =
    typeof subAgent.systemPrompt === 'function'
      ? subAgent.systemPrompt(buildCtx)
      : subAgent.systemPrompt;

  const pluginTools: PluginTool[] = Array.isArray(subAgent.tools)
    ? subAgent.tools
    : subAgent.tools(buildCtx);

  const tools: StructuredTool[] = pluginTools.map((t) =>
    wrapPluginTool(t, {
      ambient,
      state,
      sharedFactory,
      fallbackContext,
      execution,
    }),
  );

  const model = ambient.llm.get(subAgent.model ?? 'subagent');

  // Normalize `forwardTools`:
  //   true       → all of this sub-agent's own tool names
  //   string[]   → as-is
  //   false/undef → undefined (nothing forwarded)
  // Passthrough tools are NOT included — they're already on the main agent.
  let forwardTools: string[] | undefined;
  if (subAgent.forwardTools === true) {
    forwardTools = pluginTools.map((t) => t.name);
  } else if (Array.isArray(subAgent.forwardTools)) {
    forwardTools = subAgent.forwardTools;
  }

  return {
    execution,
    name: subAgent.name,
    description: subAgent.description,
    systemPrompt,
    tools,
    model,
    middleware: subAgent.middlewares,
    userDid,
    sessionId,
    logger: ambient.logger,
    ...(forwardTools ? { forwardTools } : {}),
  };
}

/**
 * Collect sub-agents from the registry and wrap each as a LangChain tool
 * using `createSubagentAsTool`. A failure inside any one sub-agent's
 * conversion logs via `ambient.logger` and is dropped from the list — the
 * graph still builds with the others.
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
    sharedFactory,
    fallbackContext,
    toAgentSpec,
    passthroughTools,
    subAgents,
  } = input;

  const entries = subAgents ?? (await registry.collect(buildCtx, rtCtx));

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
              sharedFactory,
              fallbackContext,
              input.execution,
            );
        const withPassthrough: AgentSpec = passthroughTools?.length
          ? { ...spec, passthroughTools }
          : spec;
        return createSubagentAsTool(
          withPassthrough,
          withPassthrough.forwardTools
            ? { forwardTools: withPassthrough.forwardTools }
            : undefined,
        );
      } catch (err) {
        ambient.logger.error(
          `[main-agent] sub-agent init failed for plugin "${pluginName}"; skipping: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return null;
      }
    }),
  );

  return results.flatMap((r) =>
    r.status === 'fulfilled' && r.value ? [r.value] : [],
  );
}

import type { AgentMiddleware, StructuredTool } from 'langchain';
import type { TurnBudgetTracker } from '../kernel/budget.js';
import type { ExecutionBrokerPort } from '../kernel/execution-broker.js';
import type {
  PermissionsEnforcement,
  PluginPermissions,
} from '../kernel/permissions.js';
import type {
  PluginContext,
  PluginSubAgent,
  PluginTool,
  RuntimeContext,
} from '../plugin-api/types.js';
import type {
  RegisteredSubAgent,
  SubAgentRegistry,
} from '../registries/subagent-registry.js';
import type { AmbientServices } from '../runtime-context/ambient.js';
import type { RuntimeStateInput } from '../runtime-context/build-runtime.js';
import { buildSubAgentMiddlewareStack } from './middlewares/subagent-stack.js';
import { createSubagentAsTool, type AgentSpec } from './subagent-as-tool.js';
import { wrapPluginTool } from './wrap-plugin-tool.js';

/**
 * Kernel services threaded into every sub-agent build: the shared turn
 * budget tracker, the execution broker, permission enforcement inputs, and
 * the plugin-declared sub-agent middlewares (metering). Optional as a bag —
 * lightweight test paths omit it — but when present its pieces are applied
 * without per-sub-agent opt-outs.
 */
export interface SubAgentKernel {
  tracker?: TurnBudgetTracker;
  broker?: ExecutionBrokerPort;
  enforcement?: PermissionsEnforcement;
  permissionsFor?: (pluginName: string) => PluginPermissions | undefined;
  subAgentMiddlewares: AgentMiddleware[];
}

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
  /**
   * Optional pre-collected sub-agent list. When provided, the registry is not
   * queried — callers that need to filter the entries (e.g. by visibility +
   * `loadedPlugins`) collect from the registry themselves, apply the filter,
   * and pass the result here.
   */
  subAgents?: RegisteredSubAgent[];
  /** Kernel services applied to every sub-agent build (budget, broker,
   * permission enforcement, plugin sub-agent middlewares). */
  kernel?: SubAgentKernel;
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
  pluginName: string,
  kernel?: SubAgentKernel,
): AgentSpec {
  const systemPrompt =
    typeof subAgent.systemPrompt === 'function'
      ? subAgent.systemPrompt(buildCtx)
      : subAgent.systemPrompt;

  const pluginTools: PluginTool[] = Array.isArray(subAgent.tools)
    ? subAgent.tools
    : subAgent.tools(buildCtx);

  // Inner tools go through the same kernel path as main-agent tools: the
  // owning plugin's grant attenuates the context and the shared broker
  // applies budget/timeout/audit. Delegation is not an escape hatch.
  const tools: StructuredTool[] = pluginTools.map((t) =>
    wrapPluginTool(t, {
      ambient,
      state,
      ...(kernel?.enforcement !== undefined
        ? {
            pluginName,
            permissions: kernel.permissionsFor?.(pluginName),
            enforcement: kernel.enforcement,
          }
        : {}),
      ...(kernel?.broker ? { broker: kernel.broker } : {}),
    }),
  );

  const model = ambient.llm.get(subAgent.model ?? 'subagent');

  // Kernel middlewares (budget, metering) always compose; convenience
  // middlewares (validation, repetition, retry) honor inheritMiddlewares;
  // the sub-agent's own middlewares come last.
  const middleware: AgentMiddleware[] = [
    ...(kernel
      ? buildSubAgentMiddlewareStack({
          logger: ambient.logger,
          tracker: kernel.tracker,
          kernelInherited: kernel.subAgentMiddlewares,
          inheritConvenience: subAgent.inheritMiddlewares !== false,
        })
      : []),
    ...(subAgent.middlewares ?? []),
  ];

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

  // Audit hook: refusal retries land on the ambient audit sink when one is
  // wired. Captured here (not inside the spec) so the wrapper stays free of
  // ambient knowledge.
  const audit = ambient.audit;
  const emitAudit = audit
    ? (record: Parameters<typeof audit.append>[0]): void => {
        void Promise.resolve(audit.append(record)).catch((err: unknown) => {
          ambient.logger.warn(
            `[sub-agent] audit append failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
    : undefined;

  return {
    name: subAgent.name,
    description: subAgent.description,
    systemPrompt,
    tools,
    model,
    middleware,
    userDid,
    sessionId,
    ...(forwardTools ? { forwardTools } : {}),
    ...(subAgent.onRefusal ? { onRefusal: subAgent.onRefusal } : {}),
    ...(subAgent.readOnly !== undefined ? { readOnly: subAgent.readOnly } : {}),
    ...(subAgent.recursionLimit !== undefined
      ? { recursionLimit: subAgent.recursionLimit }
      : {}),
    ...(emitAudit ? { emitAudit } : {}),
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
    subAgents,
    kernel,
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
              pluginName,
              kernel,
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

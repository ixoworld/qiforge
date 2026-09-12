import { createResultTool } from './result-tool';
import { createRequestBudgetMiddleware } from './middlewares/request-budget';
import { createAgent, type StructuredTool } from 'langchain';
import type {
  PluginContext,
  PluginManifest,
  PluginTool,
  RuntimeContext,
  SharedAccessors,
} from '../plugin-api/types';
import type { MainAgentArgs, MainAgentBuildResult } from './main-agent-types';
import { renderTier1, type Tier1Entry } from './manifest';
import { buildMetaTools } from './meta-tools';
import {
  createByoHistorySanitizerMiddleware,
  createCapabilityGateMiddleware,
  createDanglingToolCallRepairMiddleware,
  createPageContextMiddleware,
  createSafetyGuardrailMiddleware,
  createSummarizationMiddleware,
  createToolRepetitionGuardMiddleware,
  createToolValidationMiddleware,
} from './middlewares';
import {
  composePrompt,
  formatTimeContext,
  formatUserPreferences,
} from './prompt-composer';
import { formatByPlugin, type ManifestRegistry } from './registries';
import {
  buildPluginContext,
  buildRuntimeContext,
  type RunConfig,
  type RuntimeStateInput,
} from './runtime-context';
import { MainAgentGraphState } from './state';
import { collectSubAgentsWithFallback } from './sub-agent-fallback';
import { computeSubAgentToolName } from './subagent-as-tool';
import { wrapPluginTool } from './wrap-plugin-tool';

const PLUGIN_LOGGER_COMPONENT = 'main-agent';

const DEFAULT_OPERATIONAL_MODE = [
  '**General conversation mode**',
  '',
  'Default to conversation mode, using available capabilities for recall, search, and task delegation.',
].join('\n');

type CollectedTool = { pluginName: string; tool: PluginTool };

/** Map plugin name → effective `manifest.visibility` (default `on-demand`). */
function visibilityIndex(
  manifests: ManifestRegistry,
): Map<string, NonNullable<PluginManifest['visibility']>> {
  const out = new Map<string, NonNullable<PluginManifest['visibility']>>();
  for (const { pluginName, manifest } of manifests.collect()) {
    out.set(pluginName, manifest.visibility ?? 'on-demand');
  }
  return out;
}

/**
 * Filter collected tools by their effective visibility — per-tool override
 * wins; otherwise the plugin's manifest visibility decides.
 */
function selectByVisibility(
  tools: CollectedTool[],
  manifestViz: Map<string, NonNullable<PluginManifest['visibility']>>,
  visibility: NonNullable<PluginManifest['visibility']>,
): CollectedTool[] {
  return tools.filter(({ pluginName, tool }) => {
    const effective =
      tool.visibility ?? manifestViz.get(pluginName) ?? 'on-demand';
    return effective === visibility;
  });
}

/**
 * Build a compiled main agent from the runtime's registries plus per-request
 * context. Same pipeline as the Node runtime — tools from the registries
 * (boot cache + request hooks, collected concurrently with per-plugin failure
 * isolation), visibility partition, meta-tools, sub-agents as tools, the
 * fixed middleware order, prompt composition — minus the branches that do not
 * exist on Workers (the commerce lane, Slack, Matrix group chats, and the
 * ChatGPT-subscription history sanitizer). The Matrix `work_status` card
 * driver arrives as a host middleware (`hooks.middlewares`); page context and
 * the safety guardrail install when the host supplies `hooks.getRoomTitle` /
 * `hooks.safetyModel`, exactly as on Node.
 */
export async function createMainAgent(
  args: MainAgentArgs,
): Promise<MainAgentBuildResult> {
  const {
    registries,
    identity,
    config,
    requestCtx,
    ambient,
    state,
    availablePlugins,
    checkpointer,
    abortSignal,
    byoProvider,
    hooks,
  } = args;

  // ── 1. Plugin context (boot-time, no per-request fields) ────────────────
  const buildCtx: PluginContext = buildPluginContext({
    config,
    identity,
    availablePlugins,
    logger: ambient.logger,
    pluginName: PLUGIN_LOGGER_COMPONENT,
  });

  // ── 2. Request-time runtime context (drives getRequestTools/...SubAgents) ─
  ambient.logger.debug?.(
    `[MainAgent] state.loadedPlugins:`,
    state.loadedPlugins,
  );

  const loadedSet = new Set<string>(state.loadedPlugins ?? []);
  // Carry the prior request state (browserTools, agActions, …) into the
  // per-request RuntimeContext and the tool-wrapper closures, but NOT the
  // message history: keeping the full `messages` array here would pin the
  // entire history inside every tool closure for the whole run, and it would
  // be the WRONG history anyway — this snapshot is taken before the turn
  // runs. Tools that must describe the conversation read
  // `ctx.history.messages`, which `buildRuntimeContext` fills from
  // LangGraph's live `ToolRuntime.state` at call time.
  //
  // Explicit fields come last so they win over the spread (notably
  // `loadedPlugins`, which must be the de-duped Set, not the raw state array).
  const wrapState: RuntimeStateInput = {
    ...state,
    messages: [],
    userContext: state.userContext,
    loadedPlugins: loadedSet,
  };

  // `ctx.shared` — read accessors other plugins registered via
  // `getSharedState()`, evaluated lazily against the live context.
  const sharedFactory = (ctx: RuntimeContext): SharedAccessors =>
    registries.sharedState.build(ctx.history.state, ctx);

  const runConfig: RunConfig = {
    context: {
      user: {
        did: requestCtx.user.did,
        matrixUserId: requestCtx.user.matrixUserId,
        ucanDelegation: requestCtx.user.ucanDelegation,
        timezone: requestCtx.user.timezone,
        currentTime: requestCtx.user.currentTime,
      },
      session: {
        id: requestCtx.session.id,
        client: requestCtx.session.client,
        requestId: requestCtx.session.requestId,
        wsId: requestCtx.session.wsId,
        roomId: requestCtx.session.roomId,
      },
      ...(byoProvider ? { byo: { provider: byoProvider, active: true } } : {}),
    },
    ...(abortSignal ? { signal: abortSignal } : {}),
  };
  const rtCtx = buildRuntimeContext(
    runConfig,
    ambient,
    wrapState,
    sharedFactory,
  );

  // ── 3. Resolve registries (boot-time + request-time contributions) ──────
  // Tool and sub-agent collection are independent request-time fan-outs
  // (each may open network connections); run them concurrently so the
  // slower of the two — not their sum — gates the build.
  const [allTools, subAgentEntries] = await Promise.all([
    registries.tools.collect(buildCtx, rtCtx),
    registries.subAgents.collect(buildCtx, rtCtx),
  ]);

  // The per-turn tool-surface line. Request tools are named in full (there
  // are only a handful and they are the ones that vary turn to turn); the
  // full bound list, boot tools included, stays at debug.
  const requestTools = allTools.filter(({ origin }) => origin === 'request');
  ambient.logger.log(
    `[main-agent] tool surface: ${allTools.length} tools ` +
      `(boot ${allTools.length - requestTools.length}, request ${requestTools.length}) ` +
      `— request tools: ${formatByPlugin(requestTools) || '∅'}`,
  );
  ambient.logger.debug?.(
    `[main-agent] full tool surface: ${formatByPlugin(allTools) || '∅'}`,
  );
  const manifestEntries = registries.manifests.collect();
  const manifestViz = visibilityIndex(registries.manifests);
  const titleByPlugin = new Map(
    manifestEntries.map(({ pluginName, manifest }) => [
      pluginName,
      manifest.title,
    ]),
  );

  const eagerTools = selectByVisibility(allTools, manifestViz, 'always');
  // Bind ALL on-demand tools at compile time — gating happens per model call
  // in `CapabilityGateMiddleware` based on the live `loadedPlugins` state.
  // This lets `load_capability` take effect on the very next LLM call inside
  // the same run, instead of waiting for the next request to rebuild.
  const onDemandTools = selectByVisibility(allTools, manifestViz, 'on-demand');
  const silentTools = selectByVisibility(allTools, manifestViz, 'silent');

  // ── 4. Wrap tools (meta + plugin) so handlers receive a RuntimeContext ──
  const metaTools = buildMetaTools({
    manifestRegistry: registries.manifests,
    toolRegistry: registries.tools,
  });

  const fallbackContext = runConfig.context;
  const wrap = (entry: CollectedTool) =>
    wrapPluginTool(entry.tool, {
      ambient,
      state: wrapState,
      pluginTitle: titleByPlugin.get(entry.pluginName),
      sharedFactory,
      fallbackContext,
      execution: args.execution,
    });

  // ── 5. Sub-agents — bind all at compile time; gating happens at runtime ─
  // Sub-agents share the tool namespace with plugin tools, so they go through
  // the same `CapabilityGateMiddleware` filter as plugin tools.
  const subAgentTools = await collectSubAgentsWithFallback({
    registry: registries.subAgents,
    buildCtx,
    ambient,
    state: wrapState,
    userDid: requestCtx.user.did,
    sessionId: requestCtx.session.id,
    rtCtx,
    sharedFactory,
    fallbackContext,
    subAgents: subAgentEntries,
    execution: args.execution,
  });

  ambient.logger.debug?.(
    `[main-agent] binding summary (all bound; gated at runtime): ` +
      `eager=${eagerTools.length} onDemand=${onDemandTools.length} silent=${silentTools.length} ` +
      `subAgents=${subAgentEntries.length} loadedPlugins=[${Array.from(loadedSet).join(', ')}]`,
  );

  const tools: StructuredTool[] = [
    ...metaTools.map((t) =>
      wrapPluginTool(t, {
        ambient,
        state: wrapState,
        sharedFactory,
        fallbackContext,
        execution: args.execution,
      }),
    ),
    ...eagerTools.map(wrap),
    ...onDemandTools.map(wrap),
    ...silentTools.map(wrap),
    ...subAgentTools,
  ];

  if (args.execution?.store) tools.push(createResultTool(args.execution));

  // Lookups used by `CapabilityGateMiddleware` to gate on-demand plugins
  // and sub-agents per model call. Meta-tools omitted from the map are
  // pass-through.
  const pluginByToolName = new Map<string, string>();
  const visibilityByToolName = new Map<
    string,
    NonNullable<PluginManifest['visibility']>
  >();
  for (const { pluginName, tool } of allTools) {
    pluginByToolName.set(tool.name, pluginName);
    const effective =
      tool.visibility ?? manifestViz.get(pluginName) ?? 'on-demand';
    visibilityByToolName.set(tool.name, effective);
  }
  for (const { pluginName, subAgent } of subAgentEntries) {
    const toolName = computeSubAgentToolName(subAgent.name);
    pluginByToolName.set(toolName, pluginName);
    visibilityByToolName.set(
      toolName,
      manifestViz.get(pluginName) ?? 'on-demand',
    );
  }

  // ── 6. Middleware stack — always-on + plugin contributions ──────────────
  const pluginMiddlewares = registries.middlewares
    .collect(buildCtx)
    .map(({ middleware }) => middleware);

  // The summarization middleware needs the same resolver so a host's
  // `hooks.resolveModel` override covers the summary model too.
  const resolveModel = hooks?.resolveModel ?? ambient.llm.get.bind(ambient.llm);

  const middleware = [
    // Outermost: a turn that died between a tool call and its result (abort,
    // object reset) must not poison every later model request on the thread.
    createDanglingToolCallRepairMiddleware({ logger: ambient.logger }),
    // Then, as on Node: rewrite cross-provider reasoning residue before the
    // summarizer condenses (a well-formed) history.
    createByoHistorySanitizerMiddleware({ logger: ambient.logger }),
    // Condense long threads before everything tool-related.
    // Without this, thread state — reloaded, re-serialized, and re-uploaded to
    // the owner store on every turn — grows without bound.
    createSummarizationMiddleware({
      model: resolveModel(
        'routing',
        args.execution
          ? {
              maxTokens: args.execution.budget.limits.outputTokens,
              maxRetries: 0,
            }
          : undefined,
      ),
      budget: args.execution?.budget,
    }),
    createCapabilityGateMiddleware({
      pluginByToolName,
      visibilityByToolName,
      logger: ambient.logger,
    }),
    createToolValidationMiddleware({
      skipToolNames: hooks?.validationSkipToolNames,
      logger: ambient.logger,
    }),
    createToolRepetitionGuardMiddleware({ logger: ambient.logger }),

    // Same host-gated pair as the Node runtime: the page-context block needs a
    // title lookup, the safety guardrail a classification model.
    ...(hooks?.getRoomTitle
      ? [
          createPageContextMiddleware({
            getRoomTitle: hooks.getRoomTitle,
            logger: ambient.logger,
          }),
        ]
      : []),
    ...(hooks?.safetyModel
      ? [
          createSafetyGuardrailMiddleware({
            safetyModel: hooks.safetyModel,
            logger: ambient.logger,
          }),
        ]
      : []),
    ...pluginMiddlewares,
    ...(hooks?.middlewares ?? []),
    ...(args.execution
      ? [
          createRequestBudgetMiddleware({
            ...args.execution,
            log: (message) => ambient.logger.log(message),
          }),
        ]
      : []),
  ];

  // ── 7. Prompt composition ───────────────────────────────────────────────
  const eagerEntries: Tier1Entry[] = manifestEntries.filter(
    ({ manifest }) => manifest.visibility === 'always',
  );
  const tier1 = renderTier1({ manifests: eagerEntries });
  for (const warning of tier1.warnings) ambient.logger.warn(warning);

  const customInstructions = identity.prompt?.customInstructions?.trim() ?? '';

  const systemPrompt = await composePrompt({
    identity,
    capabilityBlock: tier1.block,
    customInstructions,
    operationalMode: hooks?.operationalMode ?? DEFAULT_OPERATIONAL_MODE,
    userPreferencesContext: formatUserPreferences(state.userPreferences),
    userContext: state.userContext,
    timeContext: formatTimeContext(
      requestCtx.user.timezone,
      requestCtx.user.currentTime,
    ),
    currentEntityDid: state.currentEntityDid ?? '',
    oracleNameOverride: state.userPreferences?.agentName,
    degradedServicesBlock: hooks?.degradedServicesBlock,
  });

  // ── 8. Model ────────────────────────────────────────────────────────────
  // A per-request model (already allow-list-validated by the caller) wins
  // over the role default; the adapter honours `params.model`.
  const model = resolveModel(
    'main',
    requestCtx.model ? { model: requestCtx.model } : undefined,
  );

  // ── 9. Compile ──────────────────────────────────────────────────────────
  const agent = createAgent({
    model,
    tools,
    middleware,
    stateSchema: MainAgentGraphState,
    systemPrompt,
    ...(checkpointer ? { checkpointer } : {}),
    name: identity.name,
  });

  return {
    agent,
    systemPrompt,
    boundToolNames: tools.map((t) => t.name),
    context: runConfig.context,
  };
}

export { MainAgentGraphState };
export type {
  CompiledMainAgent,
  MainAgentArgs,
  MainAgentBuildResult,
  MainAgentHooks,
  MainAgentRegistries,
  MainAgentRequestContext,
} from './main-agent-types';
export type { TMainAgentGraphState } from './state';

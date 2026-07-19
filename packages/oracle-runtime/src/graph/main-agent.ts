import {
  createAgent,
  toolRetryMiddleware,
  type StructuredTool,
} from 'langchain';
import {
  createTurnBudgetTracker,
  parseTurnBudgetEnv,
  resolveTurnBudget,
} from '../kernel/budget.js';
import { createInProcessExecutionBroker } from '../kernel/execution-broker.js';
import {
  RUNTIME_INTERNAL_PERMISSIONS,
  type PermissionsEnforcement,
  type PluginPermissions,
} from '../kernel/permissions.js';
import { renderTier1, type Tier1Entry } from '../manifest/tier1-renderer.js';
import { buildMetaTools } from '../meta-tools/index.js';
import type {
  PluginContext,
  PluginManifest,
  PluginTool,
} from '../plugin-api/types.js';
import type { ManifestRegistry } from '../registries/manifest-registry.js';
import { buildPluginContext } from '../runtime-context/build-plugin.js';
import {
  buildRuntimeContext,
  type RunConfig,
  type RuntimeStateInput,
} from '../runtime-context/build-runtime.js';
import type { CompiledMainAgent, MainAgentArgs } from './main-agent-types.js';
import {
  createEmbeddingRouteClassifier,
  createLlmRouteClassifier,
} from '../routing/classifiers.js';
import {
  parseRouterConfigEnv,
  routerConfigSchema,
  validateRouterConfig,
  type RouteClassifier,
} from '../routing/route-config.js';
import { createSemanticRouterMiddleware } from '../routing/semantic-router-middleware.js';
import { createScopedEmitter } from '../events/scoped-emitter.js';
import { createBudgetMiddleware } from './middlewares/budget-middleware.js';
import { createModelReceiptMiddleware } from './middlewares/model-receipt-middleware.js';
import {
  createCapabilityGateMiddleware,
  createPageContextMiddleware,
  createSafetyGuardrailMiddleware,
  createToolRepetitionGuardMiddleware,
  createToolValidationMiddleware,
} from './middlewares/index.js';
import {
  composePrompt,
  formatTimeContext,
  formatUserPreferences,
  SLACK_FORMATTING_CONSTRAINTS_CONTENT,
} from './prompt-composer.js';
import { MainAgentGraphState } from './state.js';
import { collectSubAgentsWithFallback } from './sub-agent-fallback.js';
import { computeSubAgentToolName } from './subagent-as-tool.js';
import { wrapPluginTool } from './wrap-plugin-tool.js';

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
 * context. Replaces the legacy 1,052-line monolith — every behaviour
 * preserved, the inlined arrays now flow from registries.
 *
 * Sandbox tools, MCP setup, and oracle→service UCAN minting (memory,
 * sandbox, composio) move into the corresponding bundled plugins; this
 * function deliberately knows nothing about them.
 */
export async function createMainAgent(
  args: MainAgentArgs,
): Promise<CompiledMainAgent> {
  const {
    registries,
    identity,
    config,
    requestCtx,
    ambient,
    state,
    availablePlugins,
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
  // Carry the prior request state (editorRoomId, spaceId, browserTools,
  // agActions, …) into the per-request RuntimeContext and the tool-wrapper
  // closures, but NOT the message history: nothing reads
  // `history.messages`/`recent()` from this context — only specific channels —
  // and keeping the full `messages` array here pinned the entire history by
  // reference inside every tool closure for the whole run. The LLM still
  // receives full history via the agent's own `stateInput`. Explicit fields
  // come last so they win over the spread (notably `loadedPlugins`, which must
  // be the de-duped Set, not the raw state array).
  const wrapState: RuntimeStateInput = {
    ...state,
    messages: [],
    userContext: state.userContext,
    loadedPlugins: loadedSet,
  };

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
    },
  };
  const rtCtx = buildRuntimeContext(runConfig, ambient, wrapState);

  // ── 3. Resolve registries (boot-time + request-time contributions) ──────
  // Tool and sub-agent collection are independent request-time fan-outs
  // (each may open network connections); run them concurrently so the
  // slower of the two — not their sum — gates the build.
  const [allTools, allSubAgents] = await Promise.all([
    registries.tools.collect(buildCtx, rtCtx),
    registries.subAgents.collect(buildCtx, rtCtx),
  ]);
  const manifestEntries = registries.manifests.collect();
  const manifestViz = visibilityIndex(registries.manifests);
  const titleByPlugin = new Map(
    manifestEntries.map(({ pluginName, manifest }) => [
      pluginName,
      manifest.title,
    ]),
  );

  // ── 3a. Kernel: per-turn budget tracker + execution broker + grants ─────
  // One tracker for the whole turn — main agent and every sub-agent share
  // its counters, so delegation cannot escape the ceilings. The broker
  // wraps every tool execution with the budget gate, per-tool timeout, and
  // an audit record.
  const permissionsByPlugin = new Map<string, PluginPermissions | undefined>(
    manifestEntries.map(({ pluginName, manifest }) => [
      pluginName,
      manifest.permissions,
    ]),
  );
  const permissionsFor = (name: string): PluginPermissions | undefined =>
    permissionsByPlugin.get(name);
  const enforcement: PermissionsEnforcement =
    config.PERMISSIONS_ENFORCEMENT === 'warn' ? 'warn' : 'enforce';
  const tracker = createTurnBudgetTracker(
    resolveTurnBudget(parseTurnBudgetEnv(config.TURN_BUDGET_JSON)),
  );
  const broker = createInProcessExecutionBroker({
    tracker,
    audit: ambient.audit,
    logger: ambient.logger,
  });

  const eagerTools = selectByVisibility(allTools, manifestViz, 'always');
  // Bind ALL on-demand tools at compile time — gating happens per model call
  // in `CapabilityGateMiddleware` based on the live `loadedPlugins` state.
  // This lets `load_capability` take effect on the very next LLM call inside
  // the same run, instead of waiting for the next request to rebuild.
  const onDemandTools = selectByVisibility(allTools, manifestViz, 'on-demand');
  const silentTools = selectByVisibility(allTools, manifestViz, 'silent');

  // ── 4. Wrap tools (meta + plugin) so handlers receive a RuntimeContext ──
  // The meta-tools receive THIS request's collected tool list as a value —
  // never the registry — so concurrent requests cannot observe each other's
  // request-time tools through `load_capability`.
  const metaTools = buildMetaTools({
    manifestRegistry: registries.manifests,
    collectedTools: allTools,
  });

  const wrap = (entry: CollectedTool) =>
    wrapPluginTool(entry.tool, {
      ambient,
      state: wrapState,
      pluginTitle: titleByPlugin.get(entry.pluginName),
      pluginName: entry.pluginName,
      permissions: permissionsFor(entry.pluginName),
      enforcement,
      broker,
    });

  // Tools flagged `subAgentPassthrough` flow into every sub-agent's tool
  // list, so sub-agents can use them without round-tripping through the main
  // agent. The flag is a plugin declaration (the memory plugin marks its
  // non-destructive tools); the runtime knows no plugin names here.
  const passthroughTools = allTools
    .filter(({ tool }) => tool.subAgentPassthrough === true)
    .map(wrap);

  // ── 5. Sub-agents — bind all at compile time; gating happens at runtime ─
  // Sub-agents share the tool namespace with plugin tools, so they go through
  // the same `CapabilityGateMiddleware` filter as plugin tools. Binding all
  // of them keeps the bound list stable across runs while still respecting
  // the manifest's visibility rule on every model call.
  const subAgentTools = await collectSubAgentsWithFallback({
    registry: registries.subAgents,
    buildCtx,
    ambient,
    state: wrapState,
    userDid: requestCtx.user.did,
    sessionId: requestCtx.session.id,
    rtCtx,
    passthroughTools,
    subAgents: allSubAgents,
    kernel: {
      tracker,
      broker,
      enforcement,
      permissionsFor,
      subAgentMiddlewares: registries.middlewares
        .collectSubAgent(buildCtx)
        .map(({ middleware }) => middleware),
    },
  });

  ambient.logger.log(
    {
      eagerTools: eagerTools.length,
      onDemandTools: onDemandTools.length,
      loadedPlugins: Array.from(loadedSet),
      silentTools: silentTools.length,
      subAgents: {
        count: allSubAgents.length,
        entries: allSubAgents.map((e) => ({
          name: e.subAgent.name,
          plugin: e.pluginName,
          visibility: manifestViz.get(e.pluginName) ?? 'on-demand',
        })),
      },
    },
    'main-agent: tool/sub-agent binding summary (all bound; gated at runtime)',
  );

  const tools: StructuredTool[] = [
    ...metaTools.map((t) =>
      wrapPluginTool(t, {
        ambient,
        state: wrapState,
        pluginName: '__meta__',
        permissions: RUNTIME_INTERNAL_PERMISSIONS,
        enforcement,
        broker,
      }),
    ),
    ...eagerTools.map(wrap),
    ...onDemandTools.map(wrap),
    ...silentTools.map(wrap),
    ...subAgentTools,
  ];

  // Lookups used by `CapabilityGateMiddleware` to gate on-demand plugins
  // and sub-agents per model call. Meta-tools/ad-hoc tools omitted from the
  // map are pass-through.
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
  for (const { pluginName, subAgent } of allSubAgents) {
    const toolName = computeSubAgentToolName(subAgent.name);
    pluginByToolName.set(toolName, pluginName);
    visibilityByToolName.set(
      toolName,
      manifestViz.get(pluginName) ?? 'on-demand',
    );
  }

  // ── 6. Middleware stack — 4 always-on + plugin contributions ────────────
  const pluginMiddlewares = registries.middlewares
    .collect(buildCtx)
    .map(({ middleware }) => middleware);

  // ── 6a. Semantic router (per-turn, ephemeral, kernel-authorized) ────────
  // Route decisions live in a request-scoped set the CapabilityGate reads —
  // never in checkpointed graph state, so classification cannot become
  // persistent authority. Targets were validated against loaded plugins and
  // the model policy below; failures leave the turn unrouted.
  const routedCapabilities = new Set<string>();
  const resolveModel = hooks?.resolveModel ?? ambient.llm.get.bind(ambient.llm);
  const routerLayer =
    hooks?.routerConfig ?? parseRouterConfigEnv(config.ROUTER_CONFIG_JSON);
  const routerConfig = routerConfigSchema.parse(routerLayer ?? {});
  let routerMiddleware: ReturnType<
    typeof createSemanticRouterMiddleware
  > | null = null;
  if (routerConfig.strategy !== 'off') {
    // Model-role existence is proven by resolving each declared role once —
    // an unresolvable role is a configuration error surfaced up front, not
    // a mid-conversation surprise.
    const resolvableRoles = new Set<string>();
    const roleErrors: string[] = [];
    for (const route of routerConfig.routes) {
      const role = route.target.modelRole;
      if (!role || resolvableRoles.has(role)) continue;
      try {
        resolveModel(role);
        resolvableRoles.add(role);
      } catch (err) {
        roleErrors.push(
          `Route '${route.name}' model role '${role}': ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const routerErrors = [
      ...validateRouterConfig(routerConfig, {
        availablePlugins,
        policyRoles: resolvableRoles,
      }),
      ...roleErrors,
    ];
    if (routerErrors.length > 0) {
      throw new Error(
        `Semantic router configuration invalid:\n  - ${routerErrors.join('\n  - ')}`,
      );
    }
    let classify: RouteClassifier;
    if (routerConfig.strategy === 'embedding') {
      const embed = hooks?.embedTexts;
      if (!embed) {
        throw new Error(
          "Semantic router strategy 'embedding' requires hooks.embedTexts (the Node adapter wires a provider-backed default).",
        );
      }
      classify = createEmbeddingRouteClassifier({
        embed,
        embedderId: 'policy:embedding',
        config: routerConfig,
      });
    } else {
      classify = createLlmRouteClassifier({
        model: resolveModel('routing'),
        config: routerConfig,
      });
    }
    const scopedEmit = createScopedEmitter(
      {
        sessionId: requestCtx.session.id,
        requestId: requestCtx.session.requestId,
      },
      ambient.emit,
    );
    routerMiddleware = createSemanticRouterMiddleware({
      config: routerConfig,
      classify,
      routedCapabilities,
      resolveModel,
      emitRouter: (payload) => scopedEmit.router(payload),
      audit: ambient.audit,
      sessionId: requestCtx.session.id,
      requestId: requestCtx.session.requestId,
      logger: ambient.logger,
    });
  }

  const middleware = [
    createBudgetMiddleware({ tracker, logger: ambient.logger }),
    ...(routerMiddleware ? [routerMiddleware] : []),
    createModelReceiptMiddleware({
      audit: ambient.audit,
      role: 'main',
      expected: hooks?.resolveModelTarget?.('main'),
      sessionId: requestCtx.session.id,
      requestId: requestCtx.session.requestId,
    }),
    createCapabilityGateMiddleware({
      pluginByToolName,
      visibilityByToolName,
      routedCapabilities,
      logger: ambient.logger,
    }),
    createToolValidationMiddleware({
      skipToolNames: hooks?.validationSkipToolNames,
      logger: ambient.logger,
    }),
    createToolRepetitionGuardMiddleware({ logger: ambient.logger }),
    toolRetryMiddleware({ onFailure: (error) => error.message }),
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
  ];

  // ── 7. Prompt composition ───────────────────────────────────────────────
  const eagerEntries: Tier1Entry[] = manifestEntries.filter(
    ({ manifest }) => manifest.visibility === 'always',
  );
  const tier1 = renderTier1({ manifests: eagerEntries });
  for (const warning of tier1.warnings) ambient.logger.warn(warning);

  // Plugin prompt contributions run AFTER binding, so a plugin can see
  // whether its surface actually attached (a sub-agent build may have
  // refused) and react — the editor plugin contributes its mode prompts, or
  // an explanatory operational mode plus a denial stub tool when its surface
  // refused to bind. The runtime composes these generically; it knows
  // nothing about any specific plugin's modes.
  const boundToolNames: ReadonlySet<string> = new Set(tools.map((t) => t.name));
  const contributions = await registries.promptContributions.collect(rtCtx, {
    boundToolNames,
    loadedPlugins: loadedSet,
  });

  let contributedOperationalMode: string | undefined;
  let contributedModeSection: string | undefined;
  const contributedInstructions: string[] = [];
  for (const { pluginName, contribution } of contributions) {
    if (contribution.operationalMode !== undefined) {
      if (contributedOperationalMode === undefined) {
        contributedOperationalMode = contribution.operationalMode;
      } else {
        ambient.logger.warn(
          `[main-agent] plugin '${pluginName}' also contributed an operational mode — first contribution wins`,
        );
      }
    }
    if (contribution.modeSection !== undefined) {
      if (contributedModeSection === undefined) {
        contributedModeSection = contribution.modeSection;
      } else {
        ambient.logger.warn(
          `[main-agent] plugin '${pluginName}' also contributed a mode section — first contribution wins`,
        );
      }
    }
    if (contribution.customInstructions) {
      contributedInstructions.push(contribution.customInstructions);
    }
    for (const tool of contribution.extraTools ?? []) {
      tools.push(wrap({ pluginName, tool }));
    }
  }

  // Custom Instructions section: author-supplied standing guidance
  // (config.prompt.customInstructions) plus whatever loaded capabilities
  // contribute (e.g. an operating guide that appears only once its plugin is
  // in `loadedPlugins`, so it costs no tokens on turns where it's unused).
  const customInstructions = [
    identity.prompt?.customInstructions?.trim(),
    ...contributedInstructions,
  ]
    .filter((part): part is string => Boolean(part && part.length > 0))
    .join('\n\n');

  const prompt = await composePrompt({
    identity,
    capabilityBlock: tier1.block,
    customInstructions,
    operationalMode:
      contributedOperationalMode ??
      hooks?.operationalMode ??
      DEFAULT_OPERATIONAL_MODE,
    editorSection: contributedModeSection ?? hooks?.editorSection ?? '',
    composioContext: hooks?.composioContext ?? '',
    slackFormattingConstraints:
      requestCtx.session.client === 'slack'
        ? SLACK_FORMATTING_CONSTRAINTS_CONTENT
        : '',
    userSecretsContext: hooks?.userSecretsContext ?? '',
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

  // ── 8. Model + checkpointer ─────────────────────────────────────────────
  const model = resolveModel('main');
  const checkpointer = hooks?.checkpointerForUser
    ? await hooks.checkpointerForUser(requestCtx.user.did)
    : undefined;

  // ── 9. Compile ──────────────────────────────────────────────────────────
  return createAgent({
    model,
    tools,
    middleware,
    stateSchema: MainAgentGraphState,
    systemPrompt: prompt,
    ...(checkpointer ? { checkpointer } : {}),
    name: identity.name,
  });
}

export { MainAgentGraphState };
export type {
  CompiledMainAgent,
  MainAgentArgs,
  MainAgentHooks,
  MainAgentRegistries,
  MainAgentRequestContext,
} from './main-agent-types.js';
export type { TMainAgentGraphState } from './state.js';

import {
  createAgent,
  toolRetryMiddleware,
  type StructuredTool,
} from 'langchain';
import { renderTier1, type Tier1Entry } from '../manifest/tier1-renderer.js';
import { buildMetaTools } from '../meta-tools/index.js';
import type {
  PluginContext,
  PluginManifest,
  PluginTool,
} from '../plugin-api/types.js';
import type { ManifestRegistry } from '../registries/manifest-registry.js';
import { MemoryPlugin } from '../plugins/memory/index.js';
import { buildPluginContext } from '../runtime-context/build-plugin.js';
import {
  buildRuntimeContext,
  type RunConfig,
  type RuntimeStateInput,
} from '../runtime-context/build-runtime.js';
import type {
  CompiledMainAgent,
  MainAgentArgs,
} from './main-agent-types.js';
import {
  createPageContextMiddleware,
  createSafetyGuardrailMiddleware,
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
import { wrapPluginTool } from './wrap-plugin-tool.js';

const PLUGIN_LOGGER_COMPONENT = 'main-agent';

const DEFAULT_OPERATIONAL_MODE = [
  '**General Conversation Mode**',
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
  const loadedSet = new Set<string>(state.loadedPlugins ?? []);
  const wrapState: RuntimeStateInput = {
    messages: state.messages ?? [],
    userContext: state.userContext,
    loadedPlugins: loadedSet,
    ...(state as Record<string, unknown>),
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
  const allTools = await registries.tools.collect(buildCtx, rtCtx);
  const manifestEntries = registries.manifests.collect();
  const manifestViz = visibilityIndex(registries.manifests);
  const titleByPlugin = new Map(
    manifestEntries.map(({ pluginName, manifest }) => [
      pluginName,
      manifest.title,
    ]),
  );

  const eagerTools = selectByVisibility(allTools, manifestViz, 'always');
  const loadedLazyTools = selectByVisibility(
    allTools,
    manifestViz,
    'on-demand',
  ).filter(({ pluginName }) => loadedSet.has(pluginName));
  const silentTools = selectByVisibility(allTools, manifestViz, 'silent');

  // ── 4. Wrap tools (meta + plugin) so handlers receive a RuntimeContext ──
  const metaTools = buildMetaTools({
    manifestRegistry: registries.manifests,
    toolRegistry: registries.tools,
  });

  const wrap = (entry: CollectedTool) =>
    wrapPluginTool(entry.tool, {
      ambient,
      state: wrapState,
      pluginTitle: titleByPlugin.get(entry.pluginName),
    });

  // Memory tools are eligible to flow into every sub-agent's tool list, so
  // any sub-agent can recall/save memory without round-tripping through the
  // main agent. `clear_memory` is excluded — destructive, main-agent-only.
  const memoryPassthrough = allTools
    .filter(({ pluginName }) => pluginName === MemoryPlugin.NAME)
    .filter(({ tool }) => tool.name !== 'clear_memory')
    .map(wrap);

  // ── 5. Sub-agents — Promise.allSettled fallback ─────────────────────────
  const subAgentTools = await collectSubAgentsWithFallback({
    registry: registries.subAgents,
    buildCtx,
    ambient,
    state: wrapState,
    userDid: requestCtx.user.did,
    sessionId: requestCtx.session.id,
    rtCtx,
    passthroughTools: memoryPassthrough,
  });

  const tools: StructuredTool[] = [
    ...metaTools.map((t) => wrapPluginTool(t, { ambient, state: wrapState })),
    ...eagerTools.map(wrap),
    ...loadedLazyTools.map(wrap),
    ...silentTools.map(wrap),
    ...subAgentTools,
  ];

  // ── 6. Middleware stack — 4 always-on + plugin contributions ────────────
  const pluginMiddlewares = registries.middlewares
    .collect(buildCtx)
    .map(({ middleware }) => middleware);

  const middleware = [
    createToolValidationMiddleware({
      skipToolNames: hooks?.validationSkipToolNames,
      logger: ambient.logger,
    }),
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

  const prompt = await composePrompt({
    identity,
    capabilityBlock: tier1.block,
    operationalMode: hooks?.operationalMode ?? DEFAULT_OPERATIONAL_MODE,
    editorSection: hooks?.editorSection ?? '',
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
  const resolveModel = hooks?.resolveModel ?? ambient.llm.get.bind(ambient.llm);
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

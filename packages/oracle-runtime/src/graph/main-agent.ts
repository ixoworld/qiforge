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
import {
  MEMORY_CLEAR_MCP_NAME,
  MemoryPlugin,
} from '../plugins/memory/index.js';
import { isUserInRoom } from '../matrix/room-membership.js';
import { createEditorAccessDeniedTool } from '../plugins/editor/editor-access-denied-tool.js';
import { EDITOR_AGENT_TOOL_NAME } from '../plugins/editor/editor-agent.js';
import {
  EDITOR_MODE_PROMPTS,
  editorUnavailableMode,
  STANDALONE_EDITOR_PROMPTS,
} from '../plugins/editor/prompts.js';
import { buildPluginContext } from '../runtime-context/build-plugin.js';
import {
  buildRuntimeContext,
  type RunConfig,
  type RuntimeStateInput,
} from '../runtime-context/build-runtime.js';
import type { CompiledMainAgent, MainAgentArgs } from './main-agent-types.js';
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

  const wrap = (entry: CollectedTool) =>
    wrapPluginTool(entry.tool, {
      ambient,
      state: wrapState,
      pluginTitle: titleByPlugin.get(entry.pluginName),
    });

  // Memory tools are eligible to flow into every sub-agent's tool list, so
  // any sub-agent can recall/save memory without round-tripping through the
  // main agent. The destructive upstream `memory-engine__clear` is excluded —
  // main-agent-only (and not in the default selectedTools anyway).
  const memoryPassthrough = allTools
    .filter(({ pluginName }) => pluginName === MemoryPlugin.NAME)
    .filter(({ tool }) => tool.name !== MEMORY_CLEAR_MCP_NAME)
    .map(wrap);

  // ── 5. Sub-agents — bind all at compile time; gating happens at runtime ─
  // Sub-agents share the tool namespace with plugin tools, so they go through
  // the same `CapabilityGateMiddleware` filter as plugin tools. Binding all
  // of them keeps the bound list stable across runs while still respecting
  // the manifest's visibility rule on every model call.
  const allSubAgents = await registries.subAgents.collect(buildCtx, rtCtx);

  const subAgentTools = await collectSubAgentsWithFallback({
    registry: registries.subAgents,
    buildCtx,
    ambient,
    state: wrapState,
    userDid: requestCtx.user.did,
    sessionId: requestCtx.session.id,
    rtCtx,
    passthroughTools: memoryPassthrough,
    subAgents: allSubAgents,
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
    ...metaTools.map((t) => wrapPluginTool(t, { ambient, state: wrapState })),
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

  const middleware = [
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

  // Editor mode is selected per-request from the live state (the static
  // `hooks` from the bundle can't carry request-scoped editorRoomId/spaceId).
  // When a page is open (`editorRoomId`) the editor prompt is the "richer mode"
  // that overrides the fork's operationalMode; with only a `spaceId` the
  // standalone variant applies. Falls back to hooks/defaults otherwise.
  //
  // Gated on `call_editor_agent` actually being bound: the editor plugin can
  // refuse to contribute its surface even when the state fields are set (room
  // membership check failed, Matrix unavailable, sub-agent build error).
  // Injecting "EDITOR MODE ACTIVE — use the Editor Agent tool" without the
  // tool bound makes the model emit its sub-agent task as user-facing text
  // instead of calling anything.
  const editorToolBound = tools.some((t) => t.name === EDITOR_AGENT_TOOL_NAME);

  // A page is open but the editor refused to bind. Tell the model WHY via a
  // dedicated operational mode AND bind a stub `call_editor_agent` that
  // returns the same denial — so even a model that ignores the prompt and
  // calls the editor learns the truth from the tool result. The membership
  // re-check hits the cache the editor plugin's own guard just populated
  // (60s TTL), so this costs no extra Matrix round-trip; `isUserInRoom`
  // fails closed, matching the plugin's decision.
  let editorUnavailableBlock: string | null = null;
  if (!editorToolBound && state.editorRoomId) {
    const isMember = await isUserInRoom(
      state.editorRoomId,
      requestCtx.user.matrixUserId,
    );
    const reason = isMember ? 'bind-error' : 'not-member';
    editorUnavailableBlock = editorUnavailableMode({
      editorRoomId: state.editorRoomId,
      reason,
    });
    tools.push(
      createEditorAccessDeniedTool({
        editorRoomId: state.editorRoomId,
        reason,
      }),
    );
    ambient.logger.warn(
      `[main-agent] editorRoomId=${state.editorRoomId} set but ${EDITOR_AGENT_TOOL_NAME} did not bind (reason: ${reason}, user: ${requestCtx.user.matrixUserId}) — ` +
        `binding access-denied stub and injecting the unavailable notice`,
    );
  } else if (!editorToolBound && state.spaceId) {
    ambient.logger.warn(
      `[main-agent] spaceId=${state.spaceId} set but ${EDITOR_AGENT_TOOL_NAME} did not bind — suppressing editor prompts; ` +
        `see preceding [editor] log lines for the refusal reason`,
    );
  }

  const editorPrompts =
    editorToolBound && state.editorRoomId
      ? EDITOR_MODE_PROMPTS
      : editorToolBound && state.spaceId
        ? STANDALONE_EDITOR_PROMPTS
        : null;

  const prompt = await composePrompt({
    identity,
    capabilityBlock: tier1.block,
    operationalMode:
      editorPrompts?.operationalMode ??
      editorUnavailableBlock ??
      hooks?.operationalMode ??
      DEFAULT_OPERATIONAL_MODE,
    editorSection: editorPrompts?.editorSection ?? hooks?.editorSection ?? '',
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

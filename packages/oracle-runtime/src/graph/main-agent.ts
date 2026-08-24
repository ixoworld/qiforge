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
import { formatByPlugin } from '../registries/tool-registry.js';
import {
  MEMORY_CLEAR_MCP_NAME,
  MemoryPlugin,
} from '../plugins/memory/index.js';
import { OraclePaymentsPlugin } from '../plugins/oracle-payments/oracle-payments.plugin.js';
import { isUserInRoom } from '../matrix/room-membership.js';
import { createEditorAccessDeniedTool } from '../plugins/editor/editor-access-denied-tool.js';
import { EDITOR_AGENT_TOOL_NAME } from '../plugins/editor/editor-agent.js';
import {
  EDITOR_MODE_PROMPTS,
  editorUnavailableMode,
  STANDALONE_EDITOR_PROMPTS,
} from '../plugins/editor/prompts.js';
import {
  FLOWS_OPERATING_GUIDE,
  FLOWS_PLUGIN_NAME,
} from '../plugins/flows/prompts.js';
import { buildPluginContext } from '../runtime-context/build-plugin.js';
import { buildCommerceOverlay } from './commerce-overlay.js';
import {
  buildRuntimeContext,
  type RunConfig,
  type RuntimeStateInput,
} from '../runtime-context/build-runtime.js';
import type { CompiledMainAgent, MainAgentArgs } from './main-agent-types.js';
import {
  createByoHistorySanitizerMiddleware,
  createCapabilityGateMiddleware,
  createPageContextMiddleware,
  createSafetyGuardrailMiddleware,
  createSummarizationMiddleware,
  createToolRepetitionGuardMiddleware,
  createToolValidationMiddleware,
  createWorkStatusMiddleware,
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

/**
 * The only plugins whose tools bind in Matrix **support** mode.
 *
 * Support mode is the front desk: the agent answers questions about the
 * oracle's services and the user's contract, and performs none of the work it
 * sells. So it gets what it needs to remember the user (memory) and everything
 * commercial (oracle-payments: the catalog, the contract card, contract
 * status, this thread's attachments, and `start_work` — the one gated route
 * into work mode). Everything else — sandbox, composio, skills, firecrawl,
 * editor, and a fork's own tools — is a way to DO work, so none of it binds
 * until an engagement is open and the turn routes to work mode.
 *
 * Keyed by contributing plugin, never by tool name: a fork's tools are work
 * tools whatever they happen to be called, and a name list would rot on the
 * first plugin anyone adds.
 */
const SUPPORT_MODE_PLUGINS: readonly string[] = [
  MemoryPlugin.NAME,
  OraclePaymentsPlugin.NAME,
];

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
  // closures, but NOT the message history: keeping the full `messages` array
  // here would pin the entire history by reference inside every tool closure
  // for the whole run, and it would be the WRONG history anyway — this
  // snapshot is taken before the turn runs (and in production the checkpoint
  // is read without its messages at all, `getTupleWithoutMessages`).
  //
  // Tools that must describe the conversation read `ctx.history.messages`,
  // which `buildRuntimeContext` fills from LangGraph's live `ToolRuntime.state`
  // at call time — the real transcript, including this turn. The LLM still
  // receives full history via the agent's own `stateInput`.
  //
  // Explicit fields come last so they win over the spread (notably
  // `loadedPlugins`, which must be the de-duped Set, not the raw state array).
  const wrapState: RuntimeStateInput = {
    ...state,
    messages: [],
    userContext: state.userContext,
    loadedPlugins: loadedSet,
  };

  // ── THE COMMERCE-LANE GUARD ─────────────────────────────────────────────
  // Everything the commerce lane changes — the support tool allowlist, the
  // contracted-billing gate, the plugin's per-mode `getRequestTools`, the
  // prompt overlay, the trace name — keys off this ONE value. It is undefined
  // unless the turn is a Matrix turn that the commerce router actually routed,
  // so HTTP, portal and Slack turns (and Matrix turns with an inert router)
  // keep the full, unrestricted surface and their existing prompt. Resolved
  // here, before the RuntimeContext is built, so plugins reading
  // `ctx.commerce` see the same guarded value the runtime does — there is no
  // second place to get this wrong.
  const commerce =
    requestCtx.session.client === 'matrix' ? requestCtx.commerce : undefined;

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
      ...(commerce !== undefined && { commerce }),
    },
  };
  const rtCtx = buildRuntimeContext(runConfig, ambient, wrapState);

  // ── 3. Resolve registries (boot-time + request-time contributions) ──────
  // Tool and sub-agent collection are independent request-time fan-outs
  // (each may open network connections); run them concurrently so the
  // slower of the two — not their sum — gates the build.
  const [collectedTools, allSubAgents] = await Promise.all([
    registries.tools.collect(buildCtx, rtCtx),
    registries.subAgents.collect(buildCtx, rtCtx),
  ]);
  // Two filters, BOTH scoped to the commerce lane and both applied at
  // collection so no later stage (visibility selection, wrapping,
  // capability-gate maps, the Tier-1 block) ever sees a tool this turn is not
  // allowed to use. Off the lane — HTTP, portal, Slack, or a Matrix turn the
  // router left alone — neither runs and the surface is exactly what it was
  // before commerce existed:
  //
  //  - Billing gate: on a routed turn, a tool marked `billing: 'contracted'`
  //    performs paid work and exists only inside an active work engagement.
  //    Off the lane there is no engagement to be inside, so a contracted tool
  //    is just a tool; dropping it there would silently shrink the surface of
  //    every non-Matrix oracle.
  //  - Support allowlist: Matrix support mode binds only the front-desk
  //    plugins (see `SUPPORT_MODE_PLUGINS`).
  const workMode = commerce?.mode === 'work';
  const supportMode = commerce?.mode === 'support';
  const allTools = collectedTools.filter(({ pluginName, tool }) => {
    if (commerce && tool.billing === 'contracted' && !workMode) return false;
    if (supportMode && !SUPPORT_MODE_PLUGINS.includes(pluginName)) return false;
    return true;
  });
  // Sub-agents share the tool namespace and are themselves ways to do work,
  // so the same allowlist decides which of them a support turn may see.
  const subAgentEntries = supportMode
    ? allSubAgents.filter(({ pluginName }) =>
        SUPPORT_MODE_PLUGINS.includes(pluginName),
      )
    : allSubAgents;

  // The per-turn tool-surface line. Request tools are named in full (there
  // are only a handful and they are the ones that vary turn to turn — the
  // commerce work/support swap lives here); the full bound list, boot tools
  // included, stays at debug.
  const requestTools = allTools.filter(({ origin }) => origin === 'request');
  const gated = collectedTools.length - allTools.length;
  ambient.logger.log(
    `[main-agent] tool surface: ${allTools.length} tools ` +
      `(boot ${allTools.length - requestTools.length}, request ${requestTools.length}` +
      `${
        gated > 0
          ? `, ${gated} hidden by the ${supportMode ? 'support-mode allowlist' : 'contracted-billing gate'}`
          : ''
      }) ` +
      `commerce=${commerce?.mode ?? 'none'} — request tools: ${formatByPlugin(requestTools) || '∅'}`,
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
  // Support mode has no meta-tools: `load_capability` cannot reach past the
  // allowlist, so the whole on-demand/`loadedPlugins` machinery has nothing
  // to do — and `list_capabilities` would advertise capabilities the agent
  // cannot use in this mode, which is worse than staying quiet about them.
  // Prompt composition drops the discovery flow to match.
  const metaTools = supportMode
    ? []
    : buildMetaTools({
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
  const subAgentTools = await collectSubAgentsWithFallback({
    registry: registries.subAgents,
    buildCtx,
    ambient,
    state: wrapState,
    userDid: requestCtx.user.did,
    sessionId: requestCtx.session.id,
    rtCtx,
    passthroughTools: memoryPassthrough,
    subAgents: subAgentEntries,
  });

  ambient.logger.log(
    {
      eagerTools: eagerTools.length,
      onDemandTools: onDemandTools.length,
      loadedPlugins: Array.from(loadedSet),
      silentTools: silentTools.length,
      subAgents: {
        count: subAgentEntries.length,
        entries: subAgentEntries.map((e) => ({
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

  // Hoisted from the model section below: the summarization middleware needs
  // the same resolver so a fork's `hooks.resolveModel` override covers the
  // summary model too.
  const resolveModel = hooks?.resolveModel ?? ambient.llm.get.bind(ambient.llm);

  const middleware = [
    // Outermost: one liveness beat per model/tool call the agent issues,
    // before any inner guard can short-circuit or retry it.
    createWorkStatusMiddleware(),
    createByoHistorySanitizerMiddleware({ logger: ambient.logger }),
    // After the sanitizer (so it condenses a well-formed history), before
    // everything tool-related. Without this, thread state — reloaded,
    // re-serialized, and re-uploaded to Matrix on every turn — grows without
    // bound and is the primary memory driver of long-lived threads.
    createSummarizationMiddleware({ model: resolveModel('routing') }),
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
  // Tier-1 describes what the agent can reach THIS turn, so in support mode it
  // covers the allowlisted plugins only, and it drops the
  // `list_capabilities`/`load_capability` footer — those tools are not bound
  // there, and a prompt that ends with instructions to call them teaches the
  // model a loading flow that cannot happen.
  const eagerEntries: Tier1Entry[] = manifestEntries.filter(
    ({ pluginName, manifest }) =>
      manifest.visibility === 'always' &&
      (!supportMode || SUPPORT_MODE_PLUGINS.includes(pluginName)),
  );
  const tier1 = renderTier1({
    manifests: eagerEntries,
    ...(supportMode && { capabilityDiscovery: false }),
  });
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
  // Support mode is not this case: the editor is withheld on purpose there, so
  // there is nothing to explain and no stub to bind.
  let editorUnavailableBlock: string | null = null;
  if (!editorToolBound && state.editorRoomId && !supportMode) {
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
  // One line per request so a "which document?" mis-answer can be traced to
  // whether the client sent `editorRoomId` at all, or the runtime dropped it.
  ambient.logger.log(
    `[main-agent] editor mode=${
      editorPrompts === EDITOR_MODE_PROMPTS
        ? 'document-open'
        : editorPrompts === STANDALONE_EDITOR_PROMPTS
          ? 'standalone'
          : 'none'
    } editorRoomId=${state.editorRoomId ?? '-'} spaceId=${state.spaceId ?? '-'} toolBound=${editorToolBound}`,
  );

  // Custom Instructions section: author-supplied standing guidance
  // (config.prompt.customInstructions) plus operating guides contributed by
  // on-demand capabilities the agent has loaded for this thread (e.g. the Flow
  // Builder guide, which appears only once `flows` is in `loadedPlugins`, so it
  // costs no tokens on turns where flows is never used).
  const customInstructions = [
    identity.prompt?.customInstructions?.trim(),
    loadedSet.has(FLOWS_PLUGIN_NAME) ? FLOWS_OPERATING_GUIDE : '',
  ]
    .filter((part): part is string => Boolean(part && part.length > 0))
    .join('\n\n');

  // Commerce overlay: rendered from the same guarded value the tool surface
  // was filtered by, so the persona in the prompt and the tools in the hand
  // can never disagree.
  const commerceOverlay = commerce ? buildCommerceOverlay(commerce) : '';

  const prompt = await composePrompt({
    identity,
    capabilityBlock: tier1.block,
    customInstructions,
    commerceOverlay,
    // Support mode binds no meta-tools, so the "scan capabilities, then load
    // them" principle would describe a flow the model cannot run.
    ...(supportMode && { capabilityDiscovery: false }),
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
  // A per-request model (already allow-list-validated in AgentBuilder) wins
  // over the role default; the provider factory honours `params.model`.
  const model = resolveModel(
    'main',
    requestCtx.model ? { model: requestCtx.model } : undefined,
  );
  const checkpointer = hooks?.checkpointerForUser
    ? await hooks.checkpointerForUser(requestCtx.user.did)
    : undefined;

  // ── 9. Compile ──────────────────────────────────────────────────────────
  // The compiled graph's name is what a LangSmith trace shows at a glance.
  // A commerce-routed Matrix turn ran one of two personas with different
  // prompts and different tools, so the two must not share a trace name;
  // every other turn keeps the plain oracle name it has always had.
  const agentName = commerce
    ? `${identity.name}-${commerce.mode}`
    : identity.name;

  return createAgent({
    model,
    tools,
    middleware,
    stateSchema: MainAgentGraphState,
    systemPrompt: prompt,
    ...(checkpointer ? { checkpointer } : {}),
    name: agentName,
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

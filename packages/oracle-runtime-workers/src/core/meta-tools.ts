import { z } from 'zod';
import { Command } from '@langchain/langgraph';
import { ToolMessage } from '@langchain/core/messages';
import { tool } from '../plugin-api/tool-helper';
import type { PluginManifest, PluginTool } from '../plugin-api/types';
import {
  describeRequirements,
  effectiveToolVisibility,
  unmetRequirements,
  type CapabilityRequirement,
} from './manifest';
import type { ManifestRegistry, ToolSummarySource } from './registries';
import { withoutWithheldExamples, type TurnToolAccess } from './tool-access';
import { USAGE_CARRIED_KWARG } from './operating-guides';
import { acquireToolLock } from './utils';

export const LOAD_CAPABILITY_TOOL_NAME = 'load_capability';
export const LIST_CAPABILITIES_TOOL_NAME = 'list_capabilities';
/** Names of the tools `buildMetaTools` returns. */
export const META_TOOL_NAMES: readonly string[] = [
  LOAD_CAPABILITY_TOOL_NAME,
  LIST_CAPABILITIES_TOOL_NAME,
];

/**
 * The part of the turn's `resolveTurnToolAccess` result the meta-tools read:
 * computed once per build from the same delegation their `ctx` carries.
 */
export type MetaToolAccess = Pick<
  TurnToolAccess<never>,
  'withheldToolNames' | 'hiddenPlugins'
>;

// ── Shared loading rules ────────────────────────────────────────────────────

/** Whether `manifest`'s plugin still has a tool behind `load_capability`. */
function hasGatedTools(
  pluginName: string,
  manifest: PluginManifest,
  toolSource: ToolSummarySource,
  access: MetaToolAccess,
): boolean {
  return toolSource
    .toolSummariesForPlugin(pluginName)
    .some(
      (tool) =>
        !access.withheldToolNames.has(tool.name) &&
        effectiveToolVisibility(tool, manifest) === 'on-demand',
    );
}

/**
 * Whether the plugin has nothing left to load: the thread loaded it, or it is
 * `always` visible with no tool behind `load_capability`.
 */
function fullyBound(
  pluginName: string,
  manifest: PluginManifest,
  loaded: ReadonlySet<string> | undefined,
  toolSource: ToolSummarySource,
  access: MetaToolAccess,
): boolean {
  return (
    loaded?.has(pluginName) === true ||
    (manifest.visibility === 'always' &&
      !hasGatedTools(pluginName, manifest, toolSource, access))
  );
}

// ── list_capabilities ───────────────────────────────────────────────────────

/**
 * Schema accepted by `list_capabilities`.
 *
 * `includeOnDemand` defaults `true` because the agent normally wants to see
 * everything it could load. `includeSilent` defaults `false` because silent
 * plugins are not loadable and are kept out of the agent's view.
 */
const listCapabilitiesSchema = z.object({
  includeOnDemand: z.boolean().default(true),
  includeSilent: z.boolean().default(false),
});

interface CapabilityListing {
  name: string;
  summary: string;
  visibility: NonNullable<PluginManifest['visibility']>;
  loaded: boolean;
  category?: PluginManifest['category'];
  tags: string[];
  /**
   * Present only when the user's authorization does not grant what the
   * plugin requires: it cannot be loaded or used until they re-authorize.
   */
  unavailable?: { missing: CapabilityRequirement[] };
}

/**
 * Build the `list_capabilities` meta-tool.
 *
 * Returns one entry per loaded plugin, with a `loaded` flag that combines
 * the boot-time always-on plugins (`visibility === 'always'`, with no tool
 * behind `load_capability`) with the set of plugins the agent has explicitly
 * loaded for this thread. A plugin left with nothing by the turn's tool
 * planes (`access.hiddenPlugins`) is not listed at all; one whose `requires`
 * are unmet is listed as `unavailable`.
 */
export function buildListCapabilitiesTool(
  manifestRegistry: ManifestRegistry,
  toolSource: ToolSummarySource,
  access: MetaToolAccess,
): PluginTool {
  return tool(
    async (args, ctx) => {
      const { includeOnDemand, includeSilent } =
        listCapabilitiesSchema.parse(args);

      const loadedSet = ctx.loadedPlugins ?? new Set<string>();

      const out: CapabilityListing[] = [];
      for (const { pluginName, manifest } of manifestRegistry.collect()) {
        const visibility: NonNullable<PluginManifest['visibility']> =
          manifest.visibility ?? 'on-demand';

        if (visibility === 'silent' && !includeSilent) continue;
        if (visibility === 'on-demand' && !includeOnDemand) continue;

        if (access.hiddenPlugins.has(pluginName)) continue;

        const missing = unmetRequirements(manifest, ctx.ucan.hasCapability);
        out.push({
          name: pluginName,
          summary: manifest.summary,
          visibility,
          loaded:
            missing.length === 0 &&
            fullyBound(pluginName, manifest, loadedSet, toolSource, access),
          category: manifest.category,
          tags: manifest.tags ?? [],
          ...(missing.length > 0 ? { unavailable: { missing } } : {}),
        });
      }
      ctx.logger.debug?.(
        `[listCapabilities] includeOnDemand: ${includeOnDemand} | includeSilent: ${includeSilent} | loadedSet: ${Array.from(loadedSet).join(', ')} | results: ${out.length}`,
      );

      // Return a JSON string — LangChain's `tool()` mis-handles a raw array
      // return (the `[content, artifact]` heuristic can drop the content).
      return JSON.stringify(out);
    },
    {
      name: LIST_CAPABILITIES_TOOL_NAME,
      description: 'List all available capabilities and their summaries.',
      schema: listCapabilitiesSchema,
    },
  );
}

// ── load_capability ─────────────────────────────────────────────────────────

const loadCapabilitySchema = z.object({
  names: z
    .array(z.string())
    .min(1)
    .describe(
      'One or more capability names to load, from the on-demand capability list.',
    ),
});

/** The note a no-op load carries, in place of the plugin's manifest. */
const ALREADY_BOUND_NOTE =
  'Nothing to load: these tools are already in your tool list. Call them directly.';

interface LoadCapabilityResult extends Partial<
  Pick<PluginManifest, 'summary' | 'whenToUse' | 'whenNotToUse' | 'examples'>
> {
  name: string;
  /**
   * `true` when the plugin had nothing left to load, `false` when this call
   * moved it into the loaded set (or refused it).
   */
  alreadyAvailable: boolean;
  /**
   * The plugin's tool names. Their definitions reach the model in its tool
   * list on the next step, so repeating the descriptions here would pay for
   * them twice, and for the rest of the conversation.
   */
  tools: string[];
  /** Present on a no-op load: says there is nothing to do. */
  note?: string;
  /**
   * The plugin's working rules (`OraclePlugin.operatingGuide`), present when
   * this call loaded it, once per turn, unless the system prompt carries them
   * (`operating-guides.ts`).
   */
  operatingGuide?: string;
  /**
   * Present when the plugin was NOT loaded: it does not exist, or the user's
   * authorization does not grant what it requires (`manifest.requires`, the
   * `missing` list).
   */
  refused?: { missing: CapabilityRequirement[]; reason: string };
}

/**
 * What a load tells the model, shared by `load_capability` and the capability
 * gate's load on a hidden tool call. Built per turn: it remembers what the
 * turn already loaded, which the tool context cannot show (a state update
 * made earlier in the turn is not in it).
 */
export interface CapabilityLoader {
  /** The plugin's tools the turn does not withhold. */
  toolNames(pluginName: string): string[];
  /**
   * What the model needs to use the plugin: how to use it, the tool names,
   * and its operating guide (once per turn) unless the prompt carries it.
   * Records the plugin as loaded this turn.
   */
  describe(
    pluginName: string,
    manifest: PluginManifest,
    guideInPrompt: boolean,
  ): LoadCapabilityResult;
  /** Whether this turn already loaded the plugin. */
  loadedThisTurn(pluginName: string): boolean;
  /** The gate's load: `describe` as a tool result. */
  describeForGate(pluginName: string): GateLoadResult;
}

/** What the capability gate's refusal adds to its tool message. */
export interface GateLoadResult {
  text: string;
  additional_kwargs: Record<string, unknown>;
}

/** What marks a message as carrying the usage of `plugins`. */
function usageMark(plugins: readonly string[]): Record<string, unknown> {
  return plugins.length > 0 ? { [USAGE_CARRIED_KWARG]: plugins } : {};
}

export function createCapabilityLoader(
  manifestRegistry: ManifestRegistry,
  toolSource: ToolSummarySource,
  access: MetaToolAccess,
): CapabilityLoader {
  const loadedThisTurn = new Set<string>();
  const guidesReturned = new Set<string>();

  const toolNames = (pluginName: string): string[] =>
    toolSource
      .toolSummariesForPlugin(pluginName)
      .filter((tool) => !access.withheldToolNames.has(tool.name))
      .map((tool) => tool.name);

  const describe: CapabilityLoader['describe'] = (
    pluginName,
    manifest,
    guideInPrompt,
  ) => {
    loadedThisTurn.add(pluginName);
    const { summary, whenToUse, whenNotToUse, examples } =
      withoutWithheldExamples(manifest, access.withheldToolNames);
    const guide =
      guideInPrompt ||
      manifest.visibility === 'always' ||
      guidesReturned.has(pluginName)
        ? undefined
        : manifestRegistry.operatingGuide(pluginName);
    if (guide) guidesReturned.add(pluginName);
    return {
      name: pluginName,
      alreadyAvailable: false,
      tools: toolNames(pluginName),
      summary,
      whenToUse,
      whenNotToUse,
      examples,
      ...(guide ? { operatingGuide: guide } : {}),
    };
  };

  return {
    toolNames,
    describe,
    loadedThisTurn: (pluginName) => loadedThisTurn.has(pluginName),
    describeForGate: (pluginName) => {
      const entry = manifestRegistry
        .collect()
        .find((m) => m.pluginName === pluginName);
      if (!entry) return { text: '', additional_kwargs: {} };
      return {
        text: JSON.stringify(describe(pluginName, entry.manifest, false)),
        additional_kwargs: usageMark([pluginName]),
      };
    },
  };
}

/** The names the error for an unknown capability offers. */
function loadableNames(
  manifestRegistry: ManifestRegistry,
  access: MetaToolAccess,
): string[] {
  return manifestRegistry
    .collect()
    .filter(
      ({ pluginName, manifest }) =>
        manifest.visibility !== 'silent' &&
        !access.hiddenPlugins.has(pluginName),
    )
    .map(({ pluginName }) => pluginName);
}

/**
 * Build the `load_capability` meta-tool.
 *
 * Accepts an array of plugin names so the agent can batch all needed
 * capabilities into a single call. A per-session lock ensures the tool
 * cannot be invoked in parallel — concurrent calls throw immediately.
 *
 * Every name is judged before any is loaded, and a name that cannot be loaded
 * never stops the rest of the batch. Behavior per name:
 *  - Unknown plugin, or one the turn's tool planes left with nothing
 *    (`access.hiddenPlugins`, answered exactly like an unknown one) →
 *    `refused`, naming the capabilities that can be loaded.
 *  - `silent` plugin → `refused` (silent plugins are not agent-loadable).
 *  - Plugin whose `requires` the user's delegation does not grant →
 *    `refused`, with what is missing.
 *  - Plugin with nothing left to load: loaded on the thread or earlier this
 *    turn, or `always` visible with no tool behind `load_capability` → a
 *    no-op entry with `alreadyAvailable: true`, its tool names and a note
 *    saying so (no state change for that plugin). An `always` plugin with
 *    `on-demand` tools does load, once.
 *  - Otherwise → added to the `loadedPlugins` state update.
 *
 * The tool names and `examples` leave out the tools the turn withholds
 * (`access.withheldToolNames`). A plugin this call loads comes with its usage
 * and its `operatingGuide` when it has one, once per turn, and the result is
 * marked as carrying them; a refused one never does.
 *
 * Return value:
 *  - If all requested plugins were already available: returns the result
 *    array directly (no state change).
 *  - If any are new: returns a LangGraph `Command` whose update appends
 *    all new plugins to `loadedPlugins` AND emits a `ToolMessage` carrying
 *    the full result array so the agent sees it on the same turn.
 */
export function buildLoadCapabilityTool(
  manifestRegistry: ManifestRegistry,
  toolSource: ToolSummarySource,
  access: MetaToolAccess,
  loader: CapabilityLoader = createCapabilityLoader(
    manifestRegistry,
    toolSource,
    access,
  ),
): PluginTool {
  return tool(
    async (args, ctx) => {
      const { names } = loadCapabilitySchema.parse(args);

      const releaseLock = acquireToolLock(`${ctx.session.id}:load_capability`);
      try {
        const refused = (
          name: string,
          reason: string,
          missing: CapabilityRequirement[] = [],
        ): LoadCapabilityResult => ({
          name,
          alreadyAvailable: false,
          tools: [],
          refused: { missing, reason },
        });
        const nothingToLoad = (name: string): LoadCapabilityResult => ({
          name,
          alreadyAvailable: true,
          tools: loader.toolNames(name),
          note: ALREADY_BOUND_NOTE,
        });

        // Judged first: `describe` records the load, so it runs only for what
        // this call really loads.
        const judged = names.map((name) => {
          const entry = manifestRegistry
            .collect()
            .find((m) => m.pluginName === name);
          if (!entry || access.hiddenPlugins.has(name))
            return refused(
              name,
              `Capability "${name}" does not exist. Loadable capabilities: ${loadableNames(manifestRegistry, access).join(', ')}.`,
            );
          if (entry.manifest.visibility === 'silent')
            return refused(
              name,
              `Capability "${name}" is internal and cannot be loaded by the agent. Loadable capabilities: ${loadableNames(manifestRegistry, access).join(', ')}.`,
            );
          const missing = unmetRequirements(
            entry.manifest,
            ctx.ucan.hasCapability,
          );
          if (missing.length > 0)
            return refused(
              name,
              `The user's authorization for this oracle does not grant ${describeRequirements(missing)}, which "${name}" requires, so it was not loaded. Tell the user; they can re-authorize the oracle with that permission and ask again.`,
              missing,
            );
          return fullyBound(
            name,
            entry.manifest,
            ctx.loadedPlugins,
            toolSource,
            access,
          )
            ? nothingToLoad(name)
            : entry.manifest;
        });

        const newToLoad: string[] = [];
        const results = judged.map((verdict, index) => {
          if ('alreadyAvailable' in verdict) return verdict;
          const name = names[index] ?? '';
          if (loader.loadedThisTurn(name)) return nothingToLoad(name);
          newToLoad.push(name);
          return loader.describe(name, verdict, false);
        });

        // Text, never the bare array: LangChain would pass an array of
        // objects through as the message's content blocks.
        if (newToLoad.length === 0) {
          return JSON.stringify(results);
        }

        const update: Record<string, unknown> = {
          loadedPlugins: newToLoad,
        };
        if (ctx.toolCallId) {
          update.capabilityUsage = newToLoad;
          update.messages = [
            new ToolMessage({
              content: JSON.stringify(results),
              tool_call_id: ctx.toolCallId,
              additional_kwargs: usageMark(newToLoad),
            }),
          ];
        }
        return new Command({ update });
      } finally {
        releaseLock();
      }
    },
    {
      name: LOAD_CAPABILITY_TOOL_NAME,
      description:
        'Load capabilities that are not in your tool list yet. Pass all you need in one call. Returns how to use each and its tool names; the tools are usable on your next step. A capability left unused for a while is unloaded; load it again when you need it. Never needed for a tool already in your tool list.',
      schema: loadCapabilitySchema,
    },
  );
}

// ── Bundle ──────────────────────────────────────────────────────────────────

/**
 * Inputs for `buildMetaTools`. The runtime passes the manifest registry and
 * the turn's own collected tools (`turnToolSummaries`); a `ToolRegistry`
 * also satisfies `toolRegistry`, but lists boot-time tools only.
 */
export interface BuildMetaToolsOptions {
  manifestRegistry: ManifestRegistry;
  toolRegistry: ToolSummarySource;
  /** The turn's tool-plane result (`resolveTurnToolAccess`). */
  toolAccess: MetaToolAccess;
  /** The turn's loader, when the capability gate shares it. */
  loader?: CapabilityLoader;
}

/**
 * Build the two meta-tools the agent always has, regardless of which
 * plugins are loaded:
 *
 *  - `load_capability`   — mark a plugin as loaded for this thread; returns
 *                          how to use it + its tool names.
 *  - `list_capabilities` — list every visible plugin with status flags.
 */
export function buildMetaTools(opts: BuildMetaToolsOptions): PluginTool[] {
  const { manifestRegistry, toolRegistry, toolAccess, loader } = opts;
  return [
    buildLoadCapabilityTool(manifestRegistry, toolRegistry, toolAccess, loader),
    buildListCapabilitiesTool(manifestRegistry, toolRegistry, toolAccess),
  ];
}

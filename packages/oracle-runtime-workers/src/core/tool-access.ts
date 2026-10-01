import { toolPlaneRequirement } from '../plugin-api/tool-plane';
import type {
  Logger,
  PluginContext,
  PluginManifest,
  PluginTool,
} from '../plugin-api/types';
import type { CapabilityRequirement } from './manifest';
import type {
  RegisteredSubAgent,
  SubAgentRegistry,
  ToolRegistry,
} from './registries';
import { computeSubAgentToolName } from './subagent-as-tool';
import { NOOP_LOGGER } from './utils';

/** `ctx.ucan.hasCapability` bound to the turn's delegation. */
export type HasCapability = (resource: string, action: string) => boolean;

/**
 * Tool-level counterpart of the manifest's `unmetRequirements`: the
 * capability `tool`'s plane requires that the delegation does not grant
 * (empty for an orchestration tool, or an admin tool it reaches).
 */
export function unmetToolRequirements(
  pluginName: string,
  tool: Pick<PluginTool, 'name' | 'plane'>,
  has: HasCapability,
): CapabilityRequirement[] {
  const required = toolPlaneRequirement(pluginName, tool);
  return required && !has(required.resource, required.action) ? [required] : [];
}

/** What the turn's delegation leaves of the collected tools and sub-agents. */
export interface TurnToolAccess<
  T extends { pluginName: string; tool: PluginTool },
> {
  /** The collected plugin tools the delegation reaches, in collection order. */
  tools: T[];
  /**
   * The sub-agents still exposed, each with its `tools` resolved and cut to
   * the ones the delegation reaches and its `forwardTools` cut to match. A
   * sub-agent that had tools and is left with none is not exposed; one
   * declared without tools (routing only) is.
   */
  subAgents: RegisteredSubAgent[];
  /**
   * Main-agent tool names the turn withholds: inaccessible admin tools and
   * the `call_*` tool of a sub-agent that is not exposed. Never bound; the
   * capability gate refuses a call naming one.
   */
  withheldToolNames: ReadonlySet<string>;
  /**
   * Plugins that contributed tools or sub-agents of which none is left.
   * Treated like a plugin whose `requires` are unmet (left out of the
   * prompt, refused by `load_capability`, never preloaded) except that they
   * are hidden outright: `list_capabilities` does not list them.
   */
  hiddenPlugins: ReadonlySet<string>;
}

/**
 * Apply the tool planes to one turn's collection. The single rule every
 * surface reads: binding, sub-agents, the Tier-1 prompt, the meta-tools,
 * the capability gate and the router's candidates.
 *
 * A sub-agent whose `tools` factory throws is dropped and logged, as its
 * conversion failure always was (`collectSubAgentsWithFallback`).
 */
export function resolveTurnToolAccess<
  T extends { pluginName: string; tool: PluginTool },
>(input: {
  tools: readonly T[];
  subAgents: readonly RegisteredSubAgent[];
  buildCtx: PluginContext;
  has: HasCapability;
  logger: Logger;
}): TurnToolAccess<T> {
  const { buildCtx, has, logger } = input;
  const reaches = (pluginName: string, tool: PluginTool): boolean =>
    unmetToolRequirements(pluginName, tool, has).length === 0;

  const contributing = new Set<string>();
  const usable = new Set<string>();
  const withheldToolNames = new Set<string>();

  const tools: T[] = [];
  for (const entry of input.tools) {
    contributing.add(entry.pluginName);
    if (reaches(entry.pluginName, entry.tool)) {
      tools.push(entry);
      usable.add(entry.pluginName);
    } else {
      withheldToolNames.add(entry.tool.name);
    }
  }

  const subAgents: RegisteredSubAgent[] = [];
  for (const { pluginName, subAgent } of input.subAgents) {
    let declared: PluginTool[];
    try {
      declared = Array.isArray(subAgent.tools)
        ? subAgent.tools
        : subAgent.tools(buildCtx);
    } catch (err) {
      logger.error(
        `[main-agent] sub-agent init failed for plugin "${pluginName}"; skipping: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }
    contributing.add(pluginName);
    const reached = declared.filter((tool) => reaches(pluginName, tool));
    if (declared.length > 0 && reached.length === 0) {
      withheldToolNames.add(computeSubAgentToolName(subAgent.name));
      continue;
    }
    const reachedNames = new Set(reached.map((tool) => tool.name));
    const withheldInner = new Set(
      declared
        .filter((tool) => !reachedNames.has(tool.name))
        .map((tool) => tool.name),
    );
    subAgents.push({
      pluginName,
      subAgent: {
        ...subAgent,
        tools: reached,
        ...(Array.isArray(subAgent.forwardTools)
          ? {
              forwardTools: subAgent.forwardTools.filter(
                (name) => !withheldInner.has(name),
              ),
            }
          : {}),
      },
    });
    usable.add(pluginName);
  }

  const hiddenPlugins = new Set(
    [...contributing].filter((pluginName) => !usable.has(pluginName)),
  );
  return { tools, subAgents, withheldToolNames, hiddenPlugins };
}

/**
 * `hiddenPlugins` from the boot-time contributions alone, for the
 * capability router, which predicts before the turn's request-time tools are
 * collected. A plugin whose request-time tools would make it usable may be
 * left out here (the router does not offer it; `load_capability` still
 * can); one whose request-time tools are all withheld may be offered, and
 * the turn's build voids that preload (`createMainAgent`).
 */
export async function bootHiddenPlugins(input: {
  registries: { tools: ToolRegistry; subAgents: SubAgentRegistry };
  buildCtx: PluginContext;
  has: HasCapability;
}): Promise<ReadonlySet<string>> {
  const { registries, buildCtx, has } = input;
  return resolveTurnToolAccess({
    tools: await registries.tools.collectBoot(buildCtx),
    subAgents: registries.subAgents.collectBoot(buildCtx),
    buildCtx,
    has,
    // A failing sub-agent is reported by the turn's build, once.
    logger: NOOP_LOGGER,
  }).hiddenPlugins;
}

/**
 * The manifest as this turn may show it: `examples` naming a withheld tool
 * removed, so neither the Tier-1 prompt nor `load_capability` teaches the
 * model a tool it cannot see. Same reference when nothing is removed.
 */
export function withoutWithheldExamples(
  manifest: PluginManifest,
  withheldToolNames: ReadonlySet<string>,
): PluginManifest {
  const examples = manifest.examples;
  if (!examples || withheldToolNames.size === 0) return manifest;
  const kept = examples.filter(
    (example) => !withheldToolNames.has(example.tool),
  );
  return kept.length === examples.length
    ? manifest
    : { ...manifest, examples: kept };
}

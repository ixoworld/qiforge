import type { PluginTool, RuntimeContext, ToolPlane } from './types';

/**
 * The ability every admin-tool capability names. Namespaced because a UCAN
 * ability must be `*` or `<ns>/<name>` (`@ixo/ucan` refuses to issue a bare
 * `invoke`); a grant of `admin-tool/*` or `*` covers it too.
 */
export const ADMIN_TOOL_ACTION = 'admin-tool/invoke';

/**
 * Root of the admin-tool resources. One admin tool is
 * `ixo:qiforge:admin-tool/<pluginName>/<toolName>`; under the runtime's
 * resource rule (a grant covers itself and every `/` child, `*` covers
 * everything) a grant on `ixo:qiforge:admin-tool/<pluginName>` covers all of
 * that plugin's admin tools and one on this root covers every admin tool.
 */
export const ADMIN_TOOL_RESOURCE = 'ixo:qiforge:admin-tool';

type ToolPlaneDescriptor = Pick<PluginTool, 'name' | 'plane'>;

/** A tool's plane; undeclared is `orchestration`. */
export function toolPlaneOf(tool: Pick<PluginTool, 'plane'>): ToolPlane {
  return tool.plane ?? 'orchestration';
}

function segment(kind: string, value: string): string {
  if (value.length === 0 || value.includes('/')) {
    // A `/` would make one tool's resource the parent of another's (plugin
    // `a` tool `b/c` vs plugin `a/b` tool `c`), so the grant rule could no
    // longer tell them apart.
    throw new TypeError(
      `admin tool ${kind} must be a non-empty name without "/" (got "${value}")`,
    );
  }
  return value;
}

/** `ixo:qiforge:admin-tool/<pluginName>/<toolName>`. */
export function adminToolResource(
  pluginName: string,
  toolName: string,
): string {
  return `${ADMIN_TOOL_RESOURCE}/${segment('plugin name', pluginName)}/${segment('tool name', toolName)}`;
}

/** The capability the user's delegation must grant for this admin tool. */
export function adminToolCapability(
  pluginName: string,
  toolName: string,
): { resource: string; action: string } {
  return {
    resource: adminToolResource(pluginName, toolName),
    action: ADMIN_TOOL_ACTION,
  };
}

/**
 * The capability `tool` requires of the turn's delegation, or `null` for an
 * orchestration tool. This is the tool-level counterpart of a manifest's
 * `requires`; every check (binding, discovery, the call itself) reads it.
 */
export function toolPlaneRequirement(
  pluginName: string,
  tool: ToolPlaneDescriptor,
): { resource: string; action: string } | null {
  return toolPlaneOf(tool) === 'admin'
    ? adminToolCapability(pluginName, tool.name)
    : null;
}

/** Whether the delegation behind `ctx` reaches `tool`. */
export function canAccessToolPlane(
  ctx: Pick<RuntimeContext, 'ucan'>,
  pluginName: string,
  tool: ToolPlaneDescriptor,
): boolean {
  const required = toolPlaneRequirement(pluginName, tool);
  return (
    required === null ||
    ctx.ucan.hasCapability(required.resource, required.action)
  );
}

/** Throws (`ctx.ucan.requireCapability`) unless the delegation behind `ctx` reaches `tool`. */
export function requireToolPlane(
  ctx: Pick<RuntimeContext, 'ucan'>,
  pluginName: string,
  tool: ToolPlaneDescriptor,
): void {
  const required = toolPlaneRequirement(pluginName, tool);
  if (required) ctx.ucan.requireCapability(required.resource, required.action);
}

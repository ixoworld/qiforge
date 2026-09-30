import type { PluginTool, RuntimeContext, ToolPlane } from './types.js';

export const ADMIN_TOOL_ACTION = 'invoke';
export const ADMIN_TOOL_RESOURCE_PREFIX = 'ixo:qiforge:admin-tool:';

type ToolPlaneDescriptor = Pick<PluginTool, 'name' | 'plane'>;

export function toolPlaneOf(tool: ToolPlaneDescriptor): ToolPlane {
  return tool.plane ?? 'orchestration';
}

export function adminToolCapability(toolName: string): {
  resource: string;
  action: string;
} {
  return {
    resource: `${ADMIN_TOOL_RESOURCE_PREFIX}${toolName}`,
    action: ADMIN_TOOL_ACTION,
  };
}

export function canAccessToolPlane(
  ctx: RuntimeContext,
  tool: ToolPlaneDescriptor,
): boolean {
  if (toolPlaneOf(tool) === 'orchestration') return true;
  const capability = adminToolCapability(tool.name);
  return ctx.ucan.hasCapability(capability.resource, capability.action);
}

export function requireToolPlane(
  ctx: RuntimeContext,
  tool: ToolPlaneDescriptor,
): void {
  if (toolPlaneOf(tool) === 'orchestration') return;
  const capability = adminToolCapability(tool.name);
  ctx.ucan.requireCapability(capability.resource, capability.action);
}

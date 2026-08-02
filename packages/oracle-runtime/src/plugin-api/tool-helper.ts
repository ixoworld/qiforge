import type { z } from 'zod';
import type { PluginTool, RuntimeContext } from './types.js';

/**
 * Authoring options for `tool()`. Mirrors the public surface of `PluginTool`
 * minus the handler (which is the first positional argument).
 */
export interface ToolHelperOptions {
  /** Tool name shown to the agent. Must be unique within the plugin. */
  name: string;
  /** Tool description shown to the agent. */
  description: string;
  /** Zod schema validating the tool's input arguments. */
  schema: z.ZodType;
  /**
   * Override visibility — by default the tool inherits the plugin's
   * `manifest.visibility` setting.
   */
  visibility?: PluginTool['visibility'];
  /**
   * What the tool does to the world, in the vocabulary the entity's
   * constitution is written in. Declaring it lets the constitution gate
   * authorize the call precisely; leaving it off means the gate has to assume
   * the worst.
   */
  effect?: PluginTool['effect'];
}

/**
 * User-facing helper to author a plugin tool.
 *
 * The handler receives the validated arguments and a `RuntimeContext` built
 * fresh per invocation. The runtime is responsible for bridging LangChain's
 * `(args, runConfig)` calling convention into `(args, ctx)` when it wires
 * the tool into the agent.
 *
 * @param handler - Async function invoked when the agent calls the tool.
 * @param options - Tool descriptor (name, description, schema, optional visibility).
 * @returns A `PluginTool` consumable by the runtime's tool registration step.
 */
export function tool(
  handler: (args: unknown, ctx: RuntimeContext) => Promise<unknown>,
  options: ToolHelperOptions,
): PluginTool {
  if (typeof handler !== 'function') {
    throw new TypeError(
      'tool(handler, options): `handler` must be a function.',
    );
  }
  if (!options || typeof options !== 'object') {
    throw new TypeError('tool(handler, options): `options` is required.');
  }
  const { name, description, schema, visibility, effect } = options;
  if (!name || typeof name !== 'string') {
    throw new TypeError(
      'tool(handler, options): `options.name` must be a non-empty string.',
    );
  }
  if (!description || typeof description !== 'string') {
    throw new TypeError(
      'tool(handler, options): `options.description` must be a non-empty string.',
    );
  }
  if (!schema) {
    throw new TypeError(
      'tool(handler, options): `options.schema` (Zod schema) is required.',
    );
  }

  const pluginTool: PluginTool = {
    name,
    description,
    schema,
    handler,
  };
  if (visibility !== undefined) {
    pluginTool.visibility = visibility;
  }
  if (effect !== undefined) {
    pluginTool.effect = effect;
  }
  return pluginTool;
}

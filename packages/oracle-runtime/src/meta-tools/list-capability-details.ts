import { z } from 'zod';
import { tool } from '../plugin-api/tool-helper.js';
import type { PluginManifest, PluginTool } from '../plugin-api/types.js';
import type { ManifestRegistry } from '../registries/manifest-registry.js';
import type { ToolRegistry } from '../registries/tool-registry.js';

/**
 * Schema accepted by `list_capability_details`.
 */
const listCapabilityDetailsSchema = z.object({
  name: z.string(),
});

interface ToolDetail {
  name: string;
  description: string;
  schemaSummary: string;
}

interface CapabilityDetail extends PluginManifest {
  tools: ToolDetail[];
}

/**
 * Build the `list_capability_details` meta-tool.
 *
 * Returns the named plugin's full manifest plus a brief summary of each
 * tool's input shape — top-level field names paired with their primitive
 * Zod type. Throws if the plugin does not exist.
 */
export function buildListCapabilityDetailsTool(
  manifestRegistry: ManifestRegistry,
  toolRegistry: ToolRegistry,
): PluginTool {
  return tool(
    async (args) => {
      const { name } = listCapabilityDetailsSchema.parse(args);

      const entry = manifestRegistry
        .collect()
        .find((m) => m.pluginName === name);

      if (!entry) {
        throw new Error(
          `Capability "${name}" does not exist. Call list_capabilities to see available plugins.`,
        );
      }

      const tools: ToolDetail[] = toolRegistry.toolsForPlugin(name).map((t) => ({
        name: t.name,
        description: t.description,
        schemaSummary: summarizeSchema(t.schema),
      }));

      const detail: CapabilityDetail = {
        ...entry.manifest,
        tools,
      };
      return detail;
    },
    {
      name: 'list_capability_details',
      description:
        'Get full details on a specific capability, including examples and tool list.',
      schema: listCapabilityDetailsSchema,
    },
  );
}

/**
 * Render a brief summary of a Zod schema's top-level shape:
 * `{ key1: type1, key2: type2 }`. Wrapped types (`optional`, `nullable`,
 * `default`) are unwrapped to surface the inner type while marking the key
 * with a trailing `?` for optional/nullable. Non-object schemas return
 * their top-level Zod type tag.
 */
export function summarizeSchema(schema: z.ZodType): string {
  if (!(schema instanceof z.ZodObject)) {
    return schema.def.type;
  }
  const parts: string[] = [];
  const shape: Record<string, z.ZodType> = schema.shape;
  for (const key of Object.keys(shape)) {
    const { typeName, optional } = describeField(shape[key]!);
    parts.push(`${key}${optional ? '?' : ''}: ${typeName}`);
  }
  return `{ ${parts.join(', ')} }`;
}

interface FieldDescription {
  typeName: string;
  optional: boolean;
}

/**
 * The minimal Zod schema surface we need to unwrap a field. Both `z.ZodType`
 * (the user-facing class) and `$ZodType` (the inner type returned by
 * `.unwrap()`) satisfy this — they both expose `def.type` and the inner
 * `def.innerType` for wrapper schemas.
 */
interface UnwrappableSchema {
  def: { type: string; innerType?: UnwrappableSchema };
}

/**
 * Unwrap optional/nullable/default wrappers via `def.innerType` and return
 * the underlying Zod type tag (e.g. `string`, `number`, `array`, `object`).
 * The `optional` flag tracks whether the field would accept `undefined` or
 * `null`. We walk via `def.innerType` rather than `.unwrap()` so the loop
 * doesn't widen to types from the inner Zod core surface.
 */
function describeField(field: z.ZodType): FieldDescription {
  let current: UnwrappableSchema = field;
  let optional = false;
  while (
    current.def.type === 'optional' ||
    current.def.type === 'nullable' ||
    current.def.type === 'default'
  ) {
    if (current.def.type !== 'default') optional = true;
    if (!current.def.innerType) break;
    current = current.def.innerType;
  }
  return {
    typeName: current.def.type,
    optional,
  };
}

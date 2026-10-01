import { z } from 'zod';
import { clientSchemaToZod, NOOP_LOGGER } from '../core/utils';
import type { Logger } from '../plugin-api/types';

/**
 * Shared adaptation layer between `@langchain/mcp-adapters` tools and the
 * plugin API's `PluginTool` contract.
 *
 * `MultiServerMCPClient.getTools()` returns `DynamicStructuredTool[]` whose
 * `schema` field carries the upstream server's raw JSON Schema (not a Zod
 * schema). The Node runtime papered over this with a type cast; here the
 * mismatch is resolved for real: {@link mcpToolZodSchema} converts the JSON
 * Schema to Zod via the runtime's `clientSchemaToZod` (the same converter the
 * core uses for client-declared tools), so the agent sees the upstream
 * contract faithfully and strict typing holds without assertions.
 */

/**
 * The slice of a `DynamicStructuredTool` the adapters read. Declared
 * structurally so `getTools()` results assign without casts and unit tests
 * can satisfy it with plain objects.
 */
export interface RawMcpClientTool {
  name: string;
  description: string;
  schema?: unknown;
  invoke(input: unknown): Promise<unknown>;
}

/** An upstream MCP tool with its schema normalised to Zod. */
export interface AdaptedMcpTool {
  name: string;
  description: string;
  schema: z.ZodType;
  invoke(input: unknown): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalise an upstream tool's `schema` field to a Zod schema:
 *
 *   - already Zod (a custom provider) → pass through verbatim;
 *   - a JSON Schema record (the `@langchain/mcp-adapters` default) →
 *     converted via `clientSchemaToZod`;
 *   - anything else / conversion failure → a permissive record schema so the
 *     tool stays callable (the upstream server validates args itself).
 */
export function mcpToolZodSchema(
  schema: unknown,
  toolName: string,
  logger: Logger = NOOP_LOGGER,
): z.ZodType {
  if (schema instanceof z.ZodType) return schema;
  if (isRecord(schema)) {
    const converted = clientSchemaToZod(schema, toolName, logger);
    if (converted) return converted;
  }
  // Loud on purpose: with the permissive fallback the upstream server becomes
  // the only validator, and the model never sees the tool's enums/required
  // fields. A silent fallback hid exactly that once.
  logger.warn(
    `[mcp] tool "${toolName}": schema not convertible to Zod (${
      isRecord(schema) ? 'conversion failed' : typeof schema
    }) — using a permissive record schema; the upstream server validates args`,
  );
  return z.record(z.string(), z.unknown());
}

/**
 * Adapt a client's tool list. Name and description pass through VERBATIM —
 * the agent sees exactly the contract the upstream MCP server publishes; only
 * the schema representation changes (JSON Schema → Zod).
 */
export function adaptMcpClientTools(
  tools: RawMcpClientTool[],
  logger: Logger = NOOP_LOGGER,
): AdaptedMcpTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    schema: mcpToolZodSchema(t.schema, t.name, logger),
    invoke: (input: unknown) => t.invoke(input),
  }));
}

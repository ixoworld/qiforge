import type { MCPAdapterConfig } from '@langchain/mcp-adapters';
import { z } from 'zod';
import { keepStructuredContent } from '../core/mcp-result';
import { clientSchemaToZod, NOOP_LOGGER } from '../core/utils';
import type { Logger } from '../plugin-api/types';

/**
 * Shared adaptation layer between `@langchain/mcp-adapters` tools and the
 * plugin API's `PluginTool` contract.
 *
 * `MCPAdapter.listTools()` returns `DynamicStructuredTool[]` whose
 * `schema` field carries the upstream server's raw JSON Schema (not a Zod
 * schema). The Node runtime papered over this with a type cast; here the
 * mismatch is resolved for real: {@link mcpToolZodSchema} converts the JSON
 * Schema to Zod via the runtime's `clientSchemaToZod` (the same converter the
 * core uses for client-declared tools), so the agent sees the upstream
 * contract faithfully and strict typing holds without assertions.
 */

export interface McpServerOptions {
  url: string;
  headers?: Record<string, string>;
  /** Reopen the server's dropped stream. */
  reconnect?: { enabled: boolean; maxAttempts: number; delayMs: number };
  /**
   * `prefixed`: `<server>__<tool>`, the names the memory, asks and Firecrawl
   * prompts and manifests use. `bare`: the upstream names as they are.
   */
  toolNames: 'prefixed' | 'bare';
}

/**
 * The `MCPAdapter` configuration of a plugin's one Streamable HTTP server.
 *
 * - `mode: 'legacy'`: the servers speak the 2025 protocol. The default
 *   `auto` sends a `server/discover` probe before every connect, and plugins
 *   connect per turn or per call. Legacy mode also keeps `reconnect`, and it
 *   never offers the server elicitation (there is no `onElicitation`
 *   handler), so no tool can pause a run to ask the user for input.
 * - `automaticSSEFallback: false`: every server speaks Streamable HTTP. In
 *   legacy mode the adapter otherwise answers any 4xx at connect (an
 *   expired token, a 403, a 429) by trying SSE at the same URL and at
 *   `/sse`, two more requests before the same failure. The error it throws
 *   still says "Authentication failed for" and keeps the HTTP error (status
 *   401) as its `cause`.
 * - Tool names: the adapter prefixes `<server>_` by default. No server
 *   prefix, and for `prefixed` the server name as the additional prefix,
 *   which the adapter joins with `__`.
 * - `afterToolCall`: {@link keepStructuredContent}.
 */
export function mcpAdapterConfig(
  serverName: string,
  options: McpServerOptions,
): MCPAdapterConfig {
  const { url, headers, reconnect, toolNames } = options;
  return {
    servers: {
      [serverName]: {
        transport: 'http',
        mode: 'legacy',
        automaticSSEFallback: false,
        url,
        ...(headers ? { headers } : {}),
        ...(reconnect ? { reconnect } : {}),
      },
    },
    prefixToolNameWithServerName: false,
    ...(toolNames === 'prefixed'
      ? { additionalToolNamePrefix: serverName }
      : {}),
    afterToolCall: keepStructuredContent,
  };
}

/**
 * The slice of a `DynamicStructuredTool` the adapters read. Declared
 * structurally so `listTools()` results assign without casts and unit tests
 * can satisfy it with plain objects.
 */
export interface RawMcpClientTool {
  name: string;
  description: string;
  schema?: unknown;
  invoke(
    input: unknown,
    config?: { metadata?: Record<string, unknown> },
  ): Promise<unknown>;
}

export interface AdaptMcpClientToolsOptions {
  /**
   * Timeout of each tool call's MCP request. `@langchain/mcp-adapters` reads
   * `metadata.timeoutMs` and hands it to the MCP SDK as the request's
   * `timeout`, a timer the SDK clears when the response arrives; without it
   * the SDK's 60 s default applies. Never pass a numeric `timeout` in the
   * call config instead: LangChain turns that into `AbortSignal.timeout`,
   * whose timer outlives the call.
   */
  requestTimeoutMs?: number;
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

/** Keywords whose value maps names to subschemas. */
const SUBSCHEMA_MAPS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);
/** Keywords whose value is a list of subschemas. */
const SUBSCHEMA_LISTS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
/** Keywords whose value is one subschema (`items` also a list, draft 7). */
const SUBSCHEMAS = new Set([
  'items',
  'additionalItems',
  'additionalProperties',
  'unevaluatedItems',
  'contains',
  'propertyNames',
]);

function mapValues(
  record: Record<string, unknown>,
  fn: (value: unknown) => unknown,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, fn(value)]),
  );
}

/**
 * A JSON Schema without the keywords `z.fromJSONSchema` refuses: `not`,
 * `unevaluatedProperties` and `if`/`then`/`else`. It throws on any of them,
 * at any depth, which would leave the model a tool without parameters. The
 * properties a `then` or `else` declares join the schema's own (the schema's
 * own win), as optional ones: which branch applies is the server's to check,
 * and the adapter validates every call's arguments against the server's full
 * schema before sending it.
 */
export function withoutUnconvertibleKeywords(schema: unknown): unknown {
  if (!isRecord(schema)) return schema;
  const {
    not: _not,
    unevaluatedProperties: _unevaluatedProperties,
    if: _if,
    then: thenBranch,
    else: elseBranch,
    ...rest
  } = schema;
  const out: Record<string, unknown> = { ...rest };
  for (const [key, value] of Object.entries(rest)) {
    if (SUBSCHEMA_MAPS.has(key) && isRecord(value))
      out[key] = mapValues(value, withoutUnconvertibleKeywords);
    else if (
      (SUBSCHEMA_LISTS.has(key) || SUBSCHEMAS.has(key)) &&
      Array.isArray(value)
    )
      out[key] = value.map(withoutUnconvertibleKeywords);
    else if (SUBSCHEMAS.has(key))
      out[key] = withoutUnconvertibleKeywords(value);
  }
  const branchProperties: Record<string, unknown> = {};
  for (const branch of [thenBranch, elseBranch].map(
    withoutUnconvertibleKeywords,
  )) {
    if (isRecord(branch) && isRecord(branch.properties))
      Object.assign(branchProperties, branch.properties);
  }
  if (Object.keys(branchProperties).length > 0)
    out.properties = {
      ...branchProperties,
      ...(isRecord(out.properties) ? out.properties : {}),
    };
  return out;
}

/**
 * Normalise an upstream tool's `schema` field to a Zod schema:
 *
 *   - already Zod (a custom provider) → pass through verbatim;
 *   - a JSON Schema record (the `@langchain/mcp-adapters` default, the
 *     server's schema as declared) → converted via `clientSchemaToZod`,
 *     after {@link withoutUnconvertibleKeywords};
 *   - anything else / conversion failure → a permissive record schema so the
 *     tool stays callable (the upstream server validates args itself).
 */
export function mcpToolZodSchema(
  schema: unknown,
  toolName: string,
  logger: Logger = NOOP_LOGGER,
): z.ZodType {
  if (schema instanceof z.ZodType) return schema;
  const convertible = withoutUnconvertibleKeywords(schema);
  if (isRecord(convertible)) {
    const converted = clientSchemaToZod(convertible, toolName, logger);
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
  options: AdaptMcpClientToolsOptions = {},
): AdaptedMcpTool[] {
  const { requestTimeoutMs } = options;
  const config =
    requestTimeoutMs === undefined
      ? undefined
      : { metadata: { timeoutMs: requestTimeoutMs } };
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    schema: mcpToolZodSchema(t.schema, t.name, logger),
    invoke: (input: unknown) => t.invoke(input, config),
  }));
}

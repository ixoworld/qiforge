import { Composio } from '@composio/core';
import { LangchainProvider } from '@composio/langchain';
import { z } from 'zod';
import type {
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types.js';

/**
 * Minimal shape of a LangChain `DynamicStructuredTool` the composio session
 * returns. The `schema` field is typed broadly because `DynamicStructuredTool`
 * permits either a Zod schema or a raw JSON schema; at runtime the composio
 * `LangchainProvider` always emits Zod (via `jsonSchemaToZodSchema`), but the
 * structural interface stays wide so a non-conforming SDK shape doesn't crash
 * the build. {@link toolSchema} narrows the value when wrapping each entry.
 */
export interface ComposioSessionTool {
  readonly name: string;
  readonly description: string;
  readonly schema: unknown;
  invoke(input: unknown): Promise<unknown>;
}

/**
 * Factory that opens a Composio session for the current user and returns the
 * dynamic tool list. Injected into the plugin so tests can stub the SDK out
 * entirely.
 */
export type ComposioSessionFactory = (
  args: ComposioSessionFactoryArgs,
) => Promise<ComposioSessionTool[]>;

export interface ComposioSessionFactoryArgs {
  /** Resolved at boot from the plugin's configSchema. */
  apiKey: string;
  /** Resolved at boot from the plugin's configSchema. */
  baseUrl: string;
  /** UCAN invocation token, minted per request — forwarded as a header. */
  ucanInvocation: string;
  /** User identifier; composio uses it as the session `user_id`. */
  userId: string;
  /** Optional `x-ixo-network` header value forwarded to composio. */
  network?: string;
}

/**
 * Default {@link ComposioSessionFactory}: opens a real Composio session using
 * `@composio/core` + `@composio/langchain`.
 */
export function createDefaultComposioSessionFactory(): ComposioSessionFactory {
  return async ({ apiKey, baseUrl, ucanInvocation, userId, network }) => {
    const defaultHeaders: Record<string, string> = {
      'x-ucan-invocation': ucanInvocation,
    };
    if (network) defaultHeaders['x-ixo-network'] = network;

    const composio = new Composio({
      apiKey,
      provider: new LangchainProvider(),
      baseURL: baseUrl,
      defaultHeaders,
    });
    const session = await composio.create(userId);
    const tools = await session.tools();
    return tools;
  };
}

export interface CreateComposioToolsOptions {
  apiKey: string;
  baseUrl: string;
  ucanInvocation: string;
  userId: string;
  network?: string;
  /** Override the session factory — defaults to the real SDK client. */
  sessionFactory?: ComposioSessionFactory;
}

/**
 * Permissive fallback schema for composio tools whose `schema` field is not
 * a Zod schema (e.g. a raw JSON schema from a non-default provider). Used by
 * {@link toolSchema} when narrowing fails so the agent still sees the tool
 * with a valid descriptor — the composio backend itself validates args.
 */
const FALLBACK_ARGS_SCHEMA = z.record(z.string(), z.unknown());

/**
 * Narrow a composio session tool's `schema` field to a Zod schema.
 *
 * The default `LangchainProvider` always converts the upstream JSON Schema to
 * a Zod schema, so this branch is the hot path. Custom providers that emit
 * raw JSON Schema (rare) fall through to the permissive record schema so the
 * tool is still discoverable.
 */
function toolSchema(schema: unknown): z.ZodType {
  return schema instanceof z.ZodType ? schema : FALLBACK_ARGS_SCHEMA;
}

/**
 * Wrap a single composio session tool as a {@link PluginTool}. The handler
 * forwards the args through the underlying `invoke` and propagates errors so
 * the agent surfaces a clean failure rather than a silent empty response.
 */
function wrapAsPluginTool(sessionTool: ComposioSessionTool): PluginTool {
  return {
    name: sessionTool.name,
    description: sessionTool.description,
    schema: toolSchema(sessionTool.schema),
    handler: async (args, ctx: RuntimeContext) => {
      try {
        return await sessionTool.invoke(args);
      } catch (error) {
        const detail =
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
        ctx.logger.error(
          `[composio] tool "${sessionTool.name}" failed: ${detail}`,
        );
        throw error;
      }
    },
  };
}

/**
 * Build the composio plugin's request-time tool list.
 *
 *   1. Opens a composio session via the configured factory.
 *   2. Wraps each returned tool into a {@link PluginTool} that proxies args
 *      to the session tool's `invoke`.
 *
 * Returns an empty list if the session factory yields no tools (e.g. the
 * user has no connected accounts and composio omits the management tools).
 */
export async function createComposioTools(
  opts: CreateComposioToolsOptions,
): Promise<PluginTool[]> {
  const sessionFactory =
    opts.sessionFactory ?? createDefaultComposioSessionFactory();

  const sessionTools = await sessionFactory({
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    ucanInvocation: opts.ucanInvocation,
    userId: opts.userId,
    network: opts.network,
  });

  return sessionTools.map(wrapAsPluginTool);
}

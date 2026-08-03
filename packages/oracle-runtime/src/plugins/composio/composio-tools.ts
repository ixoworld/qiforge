import { Composio } from '@composio/core';
import { LangchainProvider } from '@composio/langchain';
import { z } from 'zod';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types.js';

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

/**
 * Tool *definition* — the session-independent slice of a
 * {@link ComposioSessionTool}. The per-user/per-request part (the UCAN
 * invocation header baked into the session) is applied at invoke time.
 */
export interface ComposioToolDef {
  name: string;
  description: string;
  schema: unknown;
}

export interface CachedComposioDefs {
  defs: ComposioToolDef[];
  expiresAt: number;
}

/** Cache of session tool definitions, keyed per user (see {@link defsCacheKey}). */
export type ComposioDefsCache = Map<string, CachedComposioDefs>;

/**
 * The composio session surface is a stable meta-toolset (search / execute /
 * manage-connections); it shifts only when the user's connected-account state
 * flips. A short TTL keeps that fresh while removing the session-create +
 * tools-list round-trips from nearly every chat turn.
 */
export const COMPOSIO_TOOL_DEFS_TTL_MS = 5 * 60 * 1000;

/**
 * Hard ceiling on cached users. The expired-entry sweep is what bounds the
 * cache in practice (entries outlive their user by at most one TTL); the cap
 * only kicks in if more distinct users than this are active inside a single
 * TTL window, evicting the soonest-to-expire entries first.
 */
export const COMPOSIO_DEFS_CACHE_MAX_ENTRIES = 1000;

function defsCacheKey(baseUrl: string, userId: string): string {
  return `${baseUrl}::${userId}`;
}

/**
 * Cache keys with a background definition refresh in flight — guards a burst
 * of turns from each opening its own session when an entry expires.
 */
const refreshInFlight = new Set<string>();

/**
 * Drop long-expired entries (and, if still over the cap, the
 * soonest-to-expire ones). Runs on every cache write, so in a long-running
 * multi-tenant process one-off users' schemas are reclaimed instead of
 * accumulating for the process lifetime. Entries get one extra TTL of grace
 * past expiry — a recently-expired entry is still served stale while its
 * background refresh runs, so reclaiming it immediately would put the
 * session-open round-trip back on that user's next turn.
 */
function pruneDefsCache(cache: ComposioDefsCache, now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt + COMPOSIO_TOOL_DEFS_TTL_MS <= now) cache.delete(key);
  }
  const surplus = cache.size - COMPOSIO_DEFS_CACHE_MAX_ENTRIES;
  if (surplus <= 0) return;
  const soonestFirst = [...cache.entries()]
    .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
    .slice(0, surplus);
  for (const [key] of soonestFirst) cache.delete(key);
}

export interface CreateComposioToolsOptions {
  apiKey: string;
  baseUrl: string;
  ucanInvocation: string;
  userId: string;
  network?: string;
  /** Override the session factory — defaults to the real SDK client. */
  sessionFactory?: ComposioSessionFactory;
  /**
   * Optional definitions cache (owned by the plugin instance). When provided
   * and warm, the session open is deferred to the first actual tool
   * invocation; when absent, every call opens a session — the pre-cache
   * behaviour.
   */
  defsCache?: ComposioDefsCache;
  /** Logger for background-refresh failures; defaults to silent. */
  logger?: { warn(message: string): void };
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

/** Composio tool-router meta-tool that batches one or more tool executions. */
const MULTI_EXECUTE_TOOL = 'COMPOSIO_MULTI_EXECUTE_TOOL';

/**
 * Coerce the model's `COMPOSIO_MULTI_EXECUTE_TOOL` input to the exact envelope
 * Composio's (strict) schema accepts: `{ tools, sync_response_to_workbench }`.
 *
 * The multi-execute meta-tool is the one piece of the tool-router flow the
 * model keeps malforming — across runs it has dropped the required
 * `sync_response_to_workbench` control flag and hallucinated extra top-level
 * keys (e.g. a spurious `session`). Prompt guidance reduces but doesn't
 * eliminate this. Rebuilding the envelope here is deterministic:
 *
 *   - keep the model's `tools` payload verbatim — the only part it must
 *     genuinely author (a genuinely-empty call still fails upstream because
 *     `tools` is required, which is correct: there is nothing to run);
 *   - default `sync_response_to_workbench` to `false` (return each result
 *     inline rather than offloading to the remote workbench) unless the model
 *     set it explicitly;
 *   - drop every other top-level key.
 *
 * This pins the envelope *shape* — a stable meta-tool contract — not any tool
 * slugs, which live in Composio's registry and must not be hardcoded here.
 */
function normalizeArgs(toolName: string, args: unknown): unknown {
  if (
    toolName !== MULTI_EXECUTE_TOOL ||
    typeof args !== 'object' ||
    args === null ||
    Array.isArray(args)
  ) {
    return args;
  }
  const input = args as Record<string, unknown>;
  return {
    tools: input.tools,
    sync_response_to_workbench:
      typeof input.sync_response_to_workbench === 'boolean'
        ? input.sync_response_to_workbench
        : false,
  };
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
    // Composio proxies arbitrary third-party actions — sending mail, posting
    // to a channel, opening an issue. The names are chosen by Composio and
    // the connected app, so classifying them individually would mean trusting
    // a remote naming convention to describe authority. They are all
    // `execute`: this reaches outside the entity and causes effects there.
    //
    // Scoping to the toolkit rather than one blanket object lets a grant
    // admit `ixo:composio/gmail/*` without admitting every connected app.
    effect: {
      type: 'execute',
      action: sessionTool.name,
      object: () =>
        `ixo:composio/${sessionTool.name.split('_')[0]?.toLowerCase() ?? 'unknown'}`,
    },
    handler: async (args, ctx: RuntimeContext) => {
      try {
        return await sessionTool.invoke(normalizeArgs(sessionTool.name, args));
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
 * Bind cached definitions to a lazily-opened session. The session (with this
 * request's UCAN invocation) is created on the first actual invocation and
 * shared by every composio tool in the request — turns that never call
 * composio pay zero composio round-trips.
 */
function buildLazySessionTools(
  defs: ComposioToolDef[],
  sessionArgs: ComposioSessionFactoryArgs,
  sessionFactory: ComposioSessionFactory,
): PluginTool[] {
  let sessionByName: Promise<Map<string, ComposioSessionTool>> | null = null;
  const connect = (): Promise<Map<string, ComposioSessionTool>> => {
    if (!sessionByName) {
      sessionByName = sessionFactory(sessionArgs).then(
        (tools) => new Map(tools.map((t) => [t.name, t])),
      );
      // A failed session open must not poison the rest of the run — clear
      // the memo so a later invocation retries with a fresh session.
      sessionByName.catch(() => {
        sessionByName = null;
      });
    }
    return sessionByName;
  };

  return defs.map((def) =>
    wrapAsPluginTool({
      name: def.name,
      description: def.description,
      schema: def.schema,
      invoke: async (input: unknown) => {
        const byName = await connect();
        const sessionTool = byName.get(def.name);
        if (!sessionTool) {
          throw new Error(
            `composio no longer exposes "${def.name}" — cached definition is stale, retry shortly.`,
          );
        }
        return sessionTool.invoke(input);
      },
    }),
  );
}

/**
 * Build the composio plugin's request-time tool list.
 *
 *   1. Opens a composio session via the configured factory (or, with a warm
 *      `defsCache`, defers the open to the first actual invocation).
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

  const sessionArgs: ComposioSessionFactoryArgs = {
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    ucanInvocation: opts.ucanInvocation,
    userId: opts.userId,
    network: opts.network,
  };

  const cacheKey = defsCacheKey(opts.baseUrl, opts.userId);
  const cached = opts.defsCache?.get(cacheKey);
  if (cached) {
    // An expired entry is served as-is (the session meta-toolset only shifts
    // when the user's connected-account state flips) while a background
    // refresh re-snapshots it — TTL expiry never puts the session-open +
    // tools-list round-trips back on a chat turn.
    const defsCache = opts.defsCache;
    if (
      defsCache &&
      cached.expiresAt <= Date.now() &&
      !refreshInFlight.has(cacheKey)
    ) {
      refreshInFlight.add(cacheKey);
      void sessionFactory(sessionArgs)
        .then((sessionTools) => {
          defsCache.set(cacheKey, {
            defs: sessionTools.map(({ name, description, schema }) => ({
              name,
              description,
              schema,
            })),
            expiresAt: Date.now() + COMPOSIO_TOOL_DEFS_TTL_MS,
          });
          pruneDefsCache(defsCache, Date.now());
        })
        .catch((err: unknown) => {
          // Keep serving the stale defs; the next expired-cache turn
          // retries the refresh.
          opts.logger?.warn(
            `[composio] background tool-defs refresh failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        })
        .finally(() => {
          refreshInFlight.delete(cacheKey);
        });
    }
    return buildLazySessionTools(cached.defs, sessionArgs, sessionFactory);
  }

  const sessionTools = await sessionFactory(sessionArgs);
  if (opts.defsCache) {
    opts.defsCache.set(cacheKey, {
      defs: sessionTools.map(({ name, description, schema }) => ({
        name,
        description,
        schema,
      })),
      expiresAt: Date.now() + COMPOSIO_TOOL_DEFS_TTL_MS,
    });
    // Prune after the write so the cap accounts for the entry just added —
    // the fresh entry has the latest expiry, so it always survives.
    pruneDefsCache(opts.defsCache, Date.now());
  }

  return sessionTools.map(wrapAsPluginTool);
}

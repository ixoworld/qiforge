# TASK-20 firecrawl plugin — scratch notes

## Design

- `FirecrawlPlugin` extends `OraclePlugin`.
- `name = 'firecrawl'`, `version = '1.0.0'`.
- `visibility: 'always'` per task file (§16.1) and spec line 678.
- `configSchema = z.object({ FIRECRAWL_MCP_URL: z.string().url() })` — required when plugin loads.
- `getSubAgents(ctx)` returns single `Firecrawl Agent` sub-agent.

## Sub-agent tools

- `firecrawl_search` and `firecrawl_scrape` — wrapped as `PluginTool[]` with
  static Zod schemas that mirror the firecrawl MCP server contract.
- Handlers proxy through a cached `MultiServerMCPClient` instance (per
  plugin instance). The client is built lazily on the first tool call.
- The factory is injectable via the plugin constructor so tests can pass a
  stub without touching the real MCP server.

## Sync constraints

- `PluginSubAgent.tools` is sync — fine, because we define static schemas
  and only the *handlers* are async.
- The MCP client lifetime ties to the plugin instance, not per-request.
  Acceptable for v1; matches `apps/app` where `getFirecrawlMcpTools()` is
  invoked per agent build.

## Dropped per-sub-agent LLM tuning

The lifted agent sets:
- `__includeRawResponse: true`
- `modelKwargs: { include_reasoning: true }`
- `reasoning: { effort: 'low' }`

`PluginSubAgent` only exposes `model?: ModelRole`. Dropping these for v1
per the user-preferences/domain-indexer precedent. Re-introducing them is
a known plugin-API gap — surface in the report.

## Auth migration

`createFirecrawlAgent` already takes only `userDid` and `sessionId` — no
OpenID or homeServer references to strip. UCAN-only is preserved.

## Tests

4-5 focused tests:
1. plugin shape (name/version/manifest/visibility/stability)
2. `configSchema` requires a valid URL — empty or bad URL must fail
3. sub-agent registers under `Firecrawl Agent`, wraps to `call_firecrawl_agent`, exposes the two tool names
4. handler proxies the call into the injected MCP factory and returns its result
5. `createTestRuntime` boot — assertNoCollisions, assertManifestValid, listing visibility = always

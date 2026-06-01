# TASK-20: Convert `firecrawlPlugin`

**Phase:** 5 — Bundled plugin conversion
**Spec:** §16.1
**Effort:** 1 day
**Depends on:** TASK-11, TASK-15
**Blocks:** TASK-32
**Parallel with:** other plugin conversion tasks

## Goal

Convert the firecrawl feature (web scraping + search) into a plugin. Sub-agent + tools + MCP. `visibility: 'always'`.

## Deliverables

### Created

- `packages/oracle-runtime/src/plugins/firecrawl/firecrawl.plugin.ts` — class with manifest, `configSchema: { FIRECRAWL_MCP_URL: z.string() }`, `getSubAgents(ctx)` returning the firecrawl sub-agent.
- `packages/oracle-runtime/src/plugins/firecrawl/index.ts`
- `packages/oracle-runtime/src/plugins/firecrawl/firecrawl.plugin.test.ts`

### Moved (`git mv`)

- `apps/app/src/graph/agents/firecrawl-agent.ts` → `packages/oracle-runtime/src/plugins/firecrawl/firecrawl-agent.ts`
- Any related MCP-tool files for Firecrawl.

### Modified

- The sub-agent function (today: `createFirecrawlAgent`) is wrapped via `getSubAgents()` returning a `PluginSubAgent` per §4.4.

## Acceptance

- [ ] Plugin loads with `FIRECRAWL_MCP_URL` set.
- [ ] `call_firecrawl_agent` tool appears in agent's tool list (eager, since `visibility: 'always'`).
- [ ] Sub-agent invocation works end-to-end via `rt.invokeSubAgent('call_firecrawl_agent', 'scrape example.com')`.
- [ ] Test: stubbed MCP returns mock data; sub-agent returns string result.

## Out of scope

- New firecrawl features.
- Multi-tenant rate limiting.

## Notes

- The MCP setup (today: `getFirecrawlMcpTools` or similar) remains internal to the plugin.
- Sub-agent system prompt and tool list configured at `getSubAgents` time.

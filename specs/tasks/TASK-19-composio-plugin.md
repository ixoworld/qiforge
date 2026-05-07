# TASK-19: Convert `composioPlugin`

**Phase:** 5 — Bundled plugin conversion
**Spec:** §16.1
**Effort:** 2 days
**Depends on:** TASK-11, TASK-15
**Blocks:** TASK-32
**Parallel with:** other plugin conversion tasks

## Goal

Convert the Composio integration into a plugin. Auto-detected via `COMPOSIO_API_KEY`. Tools come from the Composio service dynamically. `visibility: 'on-demand'`.

## Deliverables

### Created

- `packages/oracle-runtime/src/plugins/composio/composio.plugin.ts` — class `ComposioPlugin extends OraclePlugin`. `configSchema`: `COMPOSIO_BASE_URL`, `COMPOSIO_API_KEY`. Manifest: title "Composio", category `'integration'`, `visibility: 'on-demand'`. `getTools(ctx)` calls the Composio service to fetch the dynamic tool list.
- `packages/oracle-runtime/src/plugins/composio/index.ts`
- `packages/oracle-runtime/src/plugins/composio/composio.plugin.test.ts`

### Moved (`git mv`)

- Composio-related files from today's codebase. Search for `composio` references — likely in `apps/app/src/graph/agents/main-agent.ts` (UCAN minting for Composio at lines 199-440) and possibly a Composio service file.
- `git mv` any standalone composio files (e.g. tool factories) under the new plugin dir.

### Modified

- The UCAN-minting logic for Composio (today in `main-agent.ts:441-449`) moves into the plugin's `getTools` (it's plugin-specific now, not main-agent concern).

## Acceptance

- [ ] Plugin loads when `COMPOSIO_API_KEY` is set; excluded otherwise.
- [ ] `getTools(ctx)` fetches Composio's dynamic tool list using `ctx.config.COMPOSIO_API_KEY`.
- [ ] Tools are available via `find_capability`/`load_capability` (since `'on-demand'`).
- [ ] Test: with a stubbed Composio service returning 3 tools, the plugin contributes 3 tools.

## Out of scope

- Generic dynamic-tool discovery infrastructure for other plugins. This is Composio-specific.
- The Composio context section in the system prompt (`renderComposioContext`) — that stays in `composePrompt` from TASK-10; this plugin just reports its tools.

## Notes

- The Composio prompt section (today: `composioContext` in main-agent's prompt template) is conditionally included when the plugin is loaded. Per §13.1's `composePrompt` call, the runtime checks `availablePlugins.has('composio')` to include it.
- UCAN headers for Composio tool calls: today's pattern uses `composioHeaders` with UCAN. Plugin-internal helper.

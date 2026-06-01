# TASK-22: Convert `sandboxPlugin`

**Phase:** 5 — Bundled plugin conversion
**Spec:** §16.1
**Effort:** 1.5 days
**Depends on:** TASK-11, TASK-15
**Blocks:** TASK-23 (skills depends on sandbox), TASK-32
**Parallel with:** other plugin conversion tasks (except TASK-23)

## Goal

Convert the sandbox feature (sandbox MCP tools, used internally by skills) into a plugin. `visibility: 'silent'` — agent doesn't decide to use it; it's an internal capability.

## Deliverables

### Created

- `packages/oracle-runtime/src/plugins/sandbox/sandbox.plugin.ts` — class with `configSchema: { SANDBOX_MCP_URL: z.string(), SKIP_LOGGING_CHAT_HISTORY_TO_MATRIX: z.coerce.boolean().optional() }`, manifest with `visibility: 'silent'`. `getTools(ctx)` returns sandbox tools (or `getSubAgents()` if it has a sub-agent — verify in current code).
- `packages/oracle-runtime/src/plugins/sandbox/index.ts`
- `packages/oracle-runtime/src/plugins/sandbox/sandbox.plugin.test.ts`

### Moved (`git mv`)

- Sandbox-related files. Today's main-agent.ts has UCAN minting for sandbox at lines 199-440 and tool wrapping for `sandbox_run` at lines 738+.
- Move `sandbox_run` tool wrapping (lazy secret injection: oracle secrets `x-os-*`, user secrets `x-us-*`) into this plugin's `getTools(ctx)`.

### Modified

- The sandbox-related UCAN minting moves into the plugin's `getTools`. The plugin is responsible for minting its own UCAN headers and wrapping the sandbox MCP tools with secret injection.

## Acceptance

- [ ] Plugin loads with `SANDBOX_MCP_URL` set.
- [ ] Sandbox tools available to other plugins via `availablePlugins.has('sandbox')` — specifically TASK-23 (skills) checks this.
- [ ] `sandbox_run` tool wraps with lazy secret injection (oracle + user secrets as `x-os-*` / `x-us-*` headers) — matching today's `apps/app/src/graph/agents/main-agent.ts:738+` behavior.
- [ ] Test: stubbed MCP server, `sandbox_run` tool invocation includes the right headers.

## Out of scope

- The skills logic — that's TASK-23.
- New sandbox features.

## Notes

- This plugin owns the UCAN-minting and secret-injection logic for sandbox. Today both live in main-agent; in the plugin world they belong here per §16.1's "modules-as-plugins" principle.
- Visibility silent because the agent doesn't pick "sandbox" — skills pick it.
- Watch for circular deps: skills `dependsOn: ['sandbox']` per §16.1, so sandbox must register first. Topo sort in TASK-04 handles this.

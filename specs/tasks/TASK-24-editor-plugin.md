# TASK-24: Convert `editorPlugin`

**Phase:** 5 — Bundled plugin conversion
**Spec:** §16.1
**Effort:** 2.5 days
**Depends on:** TASK-11, TASK-15
**Blocks:** TASK-32
**Parallel with:** other plugin conversion tasks

## Goal

Convert the BlockNote editor feature (editor sub-agent + tools, EditorMatrixClient) into a plugin. `visibility: 'always'`. Owns the existing `editorRoomId` state field — does NOT rename it.

## Deliverables

### Created

- `packages/oracle-runtime/src/plugins/editor/editor.plugin.ts` — class with manifest, `getSubAgents(ctx)` returning the editor sub-agent. Conditional sub-agent or tools based on `state.editorRoomId` and `state.spaceId` (matching today's `main-agent.ts:824` conditional).
- `packages/oracle-runtime/src/plugins/editor/index.ts`
- `packages/oracle-runtime/src/plugins/editor/editor.plugin.test.ts`

### Moved (`git mv`)

- `apps/app/src/graph/agents/editor/` → `packages/oracle-runtime/src/plugins/editor/agent/` (whole directory: editor-agent.ts, editor-mx.ts, block-actions.ts, blocknote-helper.ts, blocknote-tools.ts, page-tools.ts, page-functions.ts, page-memory.ts, prompts.ts, provider.ts, standalone-editor-tool.ts, survey-helpers.ts, config.ts).
- `apps/app/src/graph/nodes/tools-node/` editor-related tools (e.g. `apply_sandbox_output_to_block_tool` per `main-agent.ts:1003+`).

### Modified

- The conditional logic for `call_editor_agent`, `apply_sandbox_output_to_block_tool`, and `standalone_editor_tool` (today: `main-agent.ts:824`, `:1003`, `:1010`) becomes plugin internal. The plugin's `getSubAgents` and `getTools` decide what to expose based on `state.editorRoomId` and `state.spaceId`.

## Acceptance

- [ ] Plugin loads.
- [ ] `call_editor_agent` tool appears when `state.editorRoomId` is set.
- [ ] `standalone_editor_tool` appears when `state.spaceId` is set but no `editorRoomId` (per today's `main-agent.ts:1010` logic).
- [ ] `apply_sandbox_output_to_block_tool` appears when both `editorRoomId` and sandbox are loaded.
- [ ] Editor functionality (page memory, blocknote tools) works as today.
- [ ] No state-field rename (`editorRoomId`, `spaceId` stay as-is).
- [ ] Test: invoking `call_editor_agent` through `createTestRuntime` returns expected response.

## Out of scope

- New editor features.
- Renaming state fields.

## Notes

- Editor is the largest sub-agent today (whole `editor/` directory). Use `git mv` carefully to preserve history.
- The state fields (`editorRoomId`, `spaceId`) live at the framework level (state.ts). The plugin reads them; doesn't own them per spec.
- `EditorMatrixClient` is initialized at boot in `apps/app/src/main.ts:125-131` — that init moves into the plugin's class constructor or a NestJS module the plugin ships.

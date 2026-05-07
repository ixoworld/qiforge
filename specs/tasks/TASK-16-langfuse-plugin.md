# TASK-16: Convert `langfusePlugin` (silent)

**Phase:** 5 — Bundled plugin conversion
**Spec:** §16.1, §22.11
**Effort:** 1 day
**Depends on:** TASK-11, TASK-15
**Blocks:** TASK-32
**Parallel with:** other plugin conversion tasks

## Goal

The simplest plugin to convert. Pure observability middleware — no agent-visible tools. Visibility `'silent'`, auto-detected from 3 env vars.

## Deliverables

### Created

- `packages/oracle-runtime/src/plugins/langfuse/langfuse.plugin.ts` — class `LangfusePlugin extends OraclePlugin`. Manifest: title "Langfuse", `visibility: 'silent'`, category `'observability'`, empty `whenToUse`. `configSchema`: `LANGFUSE_SECRET_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_HOST`. `getMiddlewares(ctx)` returns the langfuse tracing middleware.
- `packages/oracle-runtime/src/plugins/langfuse/index.ts` — exports `langfusePlugin` instance.
- `packages/oracle-runtime/src/plugins/langfuse/langfuse.plugin.test.ts` — boot test using `createTestRuntime`, manifest snapshot, middleware presence.

### Source code to migrate

Search for langfuse usage in today's `apps/app/src/`:
- Likely in `apps/app/src/graph/agents/main-agent.ts` (initialization snippets) or directly in middleware setup.
- Any `langfuse.*.ts` files: `git mv` them under the new plugin dir.

## Acceptance

- [ ] Plugin class compiles and exports.
- [ ] Manifest snapshot test passes.
- [ ] When LANGFUSE_* env vars are set, plugin loads via `features.langfuse: 'auto'`.
- [ ] When env vars unset, plugin is excluded (cascade off).
- [ ] Middleware integrates into the graph (verified by `rt.assertContractsValid()`).
- [ ] No agent-visible tools added (`rt.findCapability('langfuse')` returns empty per §16.3).

## Out of scope

- Tracing of plugin internals beyond what the existing langfuse setup does.
- Replacing langfuse with another observability tool.

## Notes

- §16.3 has the manifest skeleton.
- This is the simplest plugin — use it as the template for other silent plugins (TASK-17 userPreferences).
- `failureMode` doesn't exist in v3 spec; if env vars are missing and `features.langfuse` is `true` (not auto), boot fails with `boot.plugin.env_missing`.

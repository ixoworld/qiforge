# TASK-09: `createSubagentAsTool` + 4 always-on middlewares (relocate)

**Phase:** 2 — Discovery & Composition
**Spec:** §13.4, §14.5, §22.9
**Effort:** 2 days
**Depends on:** TASK-03, TASK-05
**Blocks:** TASK-10

## Goal

Move today's `createSubagentAsTool` helper and the four always-on middlewares (`tool-validation`, `tool-retry`, `page-context`, `safety-guardrail`) into the runtime package. **No logic changes.** Use `git mv` to preserve history.

## Deliverables

### Moved (`git mv`)

- `apps/app/src/graph/agents/subagent-as-tool.ts` → `packages/oracle-runtime/src/graph/subagent-as-tool.ts`
- `apps/app/src/graph/middlewares/tool-validation-middleware.ts` → `packages/oracle-runtime/src/graph/middlewares/tool-validation-middleware.ts`
- `apps/app/src/graph/middlewares/page-context-middleware.ts` → `packages/oracle-runtime/src/graph/middlewares/page-context-middleware.ts`
- `apps/app/src/graph/middlewares/safety-guardrail-middleware.ts` → `packages/oracle-runtime/src/graph/middlewares/safety-guardrail-middleware.ts`

### Modified (after move)

- Update import paths inside the moved files to point at runtime-internal services where applicable (e.g., `MatrixManager.getInstance()` continues to work because the matrix package is unchanged).
- Tests in moved files (if any): keep passing.
- Optionally adapt `createSubagentAsTool` to accept a `RuntimeContext` parameter alongside its existing signature so plugin-defined sub-agents (TASK-10's wrapping) can pass through the right context. Don't break the current call sites — keep backwards-compatible.

### Created

- `packages/oracle-runtime/src/graph/middlewares/index.ts` — barrel exports the 4 middlewares.

## Acceptance

- [ ] `git log --follow packages/oracle-runtime/src/graph/subagent-as-tool.ts` shows pre-move history.
- [ ] All four middlewares importable from `@ixo/oracle-runtime`.
- [ ] `createSubagentAsTool` is exported from `@ixo/oracle-runtime`.
- [ ] Existing tests (if any) still pass.
- [ ] No behavior change. Nothing in `apps/app/src/graph/middlewares/` left behind.

## Out of scope

- `tool-retry-middleware`: it's a LangChain built-in (`toolRetryMiddleware`), not a file in our codebase. Just import from `langchain` in TASK-10's middleware list.
- `summarization-middleware.ts` — that one stays per-subagent (used inside `createSubagentAsTool` itself), not in the always-on list per §14.5.
- `token-limiter-middelware.ts` — that's part of `creditsPlugin` (TASK-29), not always-on.
- Adapting `createSubagentAsTool` for plugin-driven sub-agents — that wiring happens in TASK-10.

## Notes

- The four always-on middlewares per §14.5 are: tool-validation, tool-retry (LangChain built-in), page-context, safety-guardrail.
- Don't accidentally drop `safety-guardrail-middleware.ts` — v1 of the spec missed it; v3 explicitly includes it.
- Today's `createSubagentAsTool` returns a tool that the parent agent calls. The plugin runtime auto-wraps `PluginSubAgent` declarations through this helper in TASK-10.

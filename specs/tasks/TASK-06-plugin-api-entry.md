# TASK-06: Plugin API entry — class, POJO, tool helper

**Phase:** 1 — Foundation
**Spec:** §4, §22.8
**Effort:** 1.5 days
**Depends on:** TASK-05
**Blocks:** all plugin conversion tasks (TASK-16…TASK-31)

## Goal

Ship the public authoring API: the abstract class, the POJO helper, and the `tool()` helper. After this task, an external developer can write a working plugin against `@ixo/oracle-runtime`.

## Deliverables

### Created

- `packages/oracle-runtime/src/plugin-api/oracle-plugin.ts` — abstract class per §4.1 with all optional methods (`getTools`, `getSubAgents`, `getMiddlewares`, `getSharedState`).
- `packages/oracle-runtime/src/plugin-api/define-plugin.ts` — `defineOraclePlugin(spec)` identity helper per §4.2.
- `packages/oracle-runtime/src/plugin-api/tool-helper.ts` — `tool(handler, descriptor)` that produces a `PluginTool` per §4.4. Wraps LangChain's `tool()` and ensures the handler receives `RuntimeContext` instead of raw `runConfig`.
- Unit tests: instantiate a class extending `OraclePlugin`; call `defineOraclePlugin({ ... })`; build a `PluginTool` via `tool(...)` and verify it has the right name/description/schema/handler shape.

### Modified

- `packages/oracle-runtime/src/index.ts` — export `OraclePlugin`, `defineOraclePlugin`, `tool`.

## Acceptance

- [ ] A class `class FooPlugin extends OraclePlugin { name = 'foo'; ... }` compiles and its types resolve.
- [ ] Calling `defineOraclePlugin({ name, version, manifest, getTools })` returns the same object typed as `OraclePlugin`.
- [ ] `tool(async (args, ctx) => 'hi', { name, description, schema })` returns a `PluginTool` whose handler can be called with `(args, ctx: RuntimeContext)`.
- [ ] Both class form and POJO form normalize to the same internal shape (the loader can consume either).
- [ ] TypeScript narrows `ctx.config.MY_VAR` correctly when `configSchema` is set on the plugin (verify with a sample plugin that declares `configSchema: z.object({ MY_VAR: z.string() })`).

## Out of scope

- The fluent builder pattern. v3 dropped it.
- The `subAgent()` helper. Sub-agents come from the plugin's `getSubAgents()` returning `PluginSubAgent[]`; the runtime auto-wraps them in TASK-09.
- Manifest validation (TASK-02).

## Notes

- Both authoring forms (class and POJO) must produce a contribution the loader can register the same way. The loader normalizes both into an internal `OraclePluginInternal` shape.
- The `tool()` helper hides the LangChain wrapper detail from authors. Authors write `tool(handler, descriptor)` and trust the runtime to wrap the handler with `(args, runConfig) => handler(args, buildRuntimeContext(runConfig, ambient))`.
- §4.5 explains why class-based: NestJS-familiar, supports constructor params, internal state, inheritance, easy mocking.

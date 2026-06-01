# TASK-01: Package skeleton + public types

**Phase:** 1 — Foundation
**Spec:** §21.1, §21.2, §22.1, §22.2
**Effort:** 1.5 days
**Depends on:** —
**Blocks:** all subsequent tasks

## Goal

Create the `@ixo/oracle-runtime` package and define the public type surface. Nothing functional yet — just the scaffolding so other tasks have a place to land and so types can be imported across the workspace.

## Deliverables

### Created

- `packages/oracle-runtime/package.json` — name `@ixo/oracle-runtime`, version `0.0.1`, deps mirroring `@ixo/common`, main `dist/index.js`, types `dist/index.d.ts`, subpath export `./testing` per §21.3.
- `packages/oracle-runtime/tsconfig.json` — extends `@ixo/typescript-config/base.json`.
- `packages/oracle-runtime/src/index.ts` — barrel re-exports per §22.2 (most types still empty stubs).
- `packages/oracle-runtime/src/plugin-api/types.ts` — every public type from §4.1 (`PluginTool`, `PluginSubAgent`), §5.1 (`PluginManifest`, `ManifestExample`), §6.1 (`PluginContext`), §6.2 (`RuntimeContext`).
- `packages/oracle-runtime/src/plugin-api/oracle-plugin.ts` — abstract class skeleton from §4.1 (no implementations; `throw new Error('not implemented')` in any helpers).
- Empty subdirs from §21.1 with `.gitkeep`: `bootstrap/`, `runtime-context/`, `graph/`, `meta-tools/`, `manifest/`, `registries/`, `plugins/`, `modules/`, `matrix/`, `events/`, `config/`, `testing/`.

### Modified

- root `pnpm-workspace.yaml` — add `packages/oracle-runtime` if not auto-globbed.

## Acceptance

- [ ] `pnpm install` resolves without error.
- [ ] `pnpm build --filter @ixo/oracle-runtime` compiles cleanly (warnings allowed).
- [ ] From a sibling package, `import { OraclePlugin } from '@ixo/oracle-runtime'` resolves and is recognized as an abstract class.
- [ ] All public type names listed in §22.2 are exported from `src/index.ts` (even if some reference stub interfaces).
- [ ] `import { createTestRuntime } from '@ixo/oracle-runtime/testing'` resolves to a stub.

## Out of scope

- Implementing any logic. Function bodies throw `not implemented`.
- The `tool()` helper, `defineOraclePlugin` (TASK-06).
- Manifest validation (TASK-02).
- Registries (TASK-03).

## Notes

- Mirror `@ixo/common`'s `package.json` shape — same build script, same tsconfig structure, same lint config.
- Re-exports from `zod`, `@langchain/core/tools`, `@langchain/langgraph`, and `langchain` per §22.2.

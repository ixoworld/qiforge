# Internal docs — QiForge framework maintainers

This directory is for people **growing the framework**. If you're building an oracle with QiForge (i.e. using the framework, not editing it), read the public docs at `ixo-docs/build-an-oracle/` instead.

The structure mirrors the parts of the codebase a maintainer touches:

| Folder | What it covers |
| --- | --- |
| `architecture/` | How the runtime is wired internally — bootstrap, registries, graph composition, Matrix/checkpointer, modules. |
| `contributing/` | Concrete how-tos for extending the framework: adding a bundled plugin, a module, a state field, a meta-tool, an always-on middleware, plus code conventions. |
| `spec-and-roadmap/` | Pointers to the spec, the task index, follow-up items deferred out of v1. |
| `testing/` | The test harness, integration test patterns, CI. |

## When to update which doc

- **Touching `packages/oracle-runtime/src/bootstrap/`?** → update `architecture/boot-sequence.md`.
- **Touching `packages/oracle-runtime/src/plugin-api/`?** → update `architecture/plugin-lifecycle.md`. Public-facing changes also go in `ixo-docs/build-an-oracle/reference/plugin-api.mdx`.
- **Adding a bundled plugin?** → follow `contributing/adding-a-bundled-plugin.md`. Add a row to `ixo-docs/build-an-oracle/reference/plugin-catalog.mdx`.
- **Touching `packages/oracle-runtime/src/modules/`?** → update `architecture/modules.md`.
- **Adding a graph state field?** → follow `contributing/adding-a-state-field.md`. Document the field in `ixo-docs/build-an-oracle/reference/state-schema.mdx`.
- **Touching the meta-tools?** → update `architecture/meta-tools-and-discovery.md` and `ixo-docs/build-an-oracle/concepts/meta-tools.mdx`.
- **Adding a follow-up ticket?** → append to `spec-and-roadmap/follow-ups.md`.

## What this directory is NOT

- It's not the public docs. Public-facing content lives in `ixo-docs/` (Mintlify). Don't duplicate content between the two — link.
- It's not a changelog. Source of truth is the git history and the spec.
- It's not the spec. Spec lives in `specs/ORA-219-plugin-based-runtime.md`. These docs reference it; they don't restate it.

## House rules

- **Reference source files by path** (`packages/oracle-runtime/src/bootstrap/plugin-loader.ts`) so a reader can `cd` to the file. Don't paraphrase what code does — link to it.
- **Mermaid diagrams only.** GitHub renders them natively; no images, no exports.
- **No marketing tone.** This is for engineers. Plain, terse, accurate.
- **Update with the change**, not after. A PR that changes how boot works should also touch `architecture/boot-sequence.md`.

## Memory rules that apply

Several memory rules in `CLAUDE.md` apply to maintainer work — re-read them before contributing:

- No `as any` / `as Type` to silence the compiler — find the actual mismatch.
- No `skipMatrixInit` / `skipGracefulShutdown` in integration tests.
- No skip-real-services flags as test speed-ups.
- Don't override upstream MCP tool descriptions in plugin code — guidance goes in the manifest's `whenToUse` / `whenNotToUse` instead.
- Don't loosen test assertions to mask failures.
- Don't edit plugin code to make tests pass. Plugin source is presumed-working production code; tests describe behaviour, not dictate it. Test-side retries max 2.

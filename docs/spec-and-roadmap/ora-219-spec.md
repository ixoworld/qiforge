# ORA-219 spec — reading guide

The full spec is at `specs/ORA-219-plugin-based-runtime.md`. ~2000 lines, structured by parts.

## What it covers

| Part                              | Spec sections | What's in it                                                                                              |
| --------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------- |
| Part I — Foundations              | §1–§3         | Executive summary, goals + non-goals, the mental model (three levers, two contexts, big-picture diagram). |
| Part II — Plugin API              | §4–§8         | Plugin class shape, manifest schema, the two contexts, soft deps + shared state, config schema.           |
| Part III — Dynamic Plugin Loading | §9–§11        | Visibility tiers, the meta-tools, the `loadedPlugins` state field.                                        |
| Part IV — Runtime Integration     | §12–§15       | Internal registries, LangGraph composition, boot sequence, `createOracleApp` and NestJS access.           |
| Part V — Bundled Plugins          | §16–§17       | The bundled plugin catalog and per-plugin env vars.                                                       |
| Part VI — DX                      | §18–§21       | The starter app shape, worked examples, testing harness, package layout.                                  |
| Part VII — Implementation         | §22–§23       | Implementation checklist and open decisions.                                                              |
| Part VIII — Reference             | §24–§25       | Glossary and code-grounding appendix.                                                                     |

## How to read it

If you're picking up the plugin runtime for the first time:

1. Read §1–§3 in full. It's the mental model.
2. Skim §4–§8. The plugin class shape and the two contexts are the public contracts.
3. Skim §9–§11. The visibility tiers and meta-tools explain dynamic loading.
4. Reference §16–§17 when working on a specific bundled plugin.
5. Reference §22 (implementation checklist) and `specs/tasks/README.md` when planning a change.

If you're implementing a specific task, the task file (`specs/tasks/TASK-NN-...md`) cites the relevant §N. Open the spec at that section.

## Where the spec differs from shipped code

See [README — when the spec disagrees with code](README.md#when-the-spec-disagrees-with-code).

The biggest known divergences:

- Two meta-tools instead of four.
- `tasks` and `calls` plugins shipped as stubs.
- `claim-processing` merged into `credits` (the two plugins were inseparable).
- `langfuse` removed in favour of LangChain's built-in LangSmith tracing via `LANGSMITH_*` env vars on the base schema.

`specs/tasks/README.md` has the full deferred / removed / merged notes.

## Update policy

The spec is treated as design history. We don't rewrite it to reflect what shipped — we leave the design as-was and note divergences in the task index and in these docs.

If a _new_ design decision is needed (not just clarification of an existing one), open a new spec file in `specs/` rather than editing ORA-219.

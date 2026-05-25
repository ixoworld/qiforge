# Spec and roadmap

Pointers to the source-of-truth design artefacts. These docs don't restate the spec — they link to it and provide enough orientation to find what you need.

## Source of truth

| Artefact                    | Path                                          | Use it for                                                                         |
| --------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------- |
| ORA-219 spec                | `specs/ORA-219-plugin-based-runtime.md`       | Every design decision behind the plugin runtime. ~2000 lines, structured by parts. |
| Task index                  | `specs/tasks/README.md`                       | Status of every implementation task, dependency graph, phase notes.                |
| Individual tasks            | `specs/tasks/TASK-*.md`                       | Deliverables and acceptance criteria for each task.                                |
| Follow-up ticket: logger    | `specs/tasks/TASK-FOLLOWUP-logger.md`         | Outstanding non-spec work that blocks 1.0.0.                                       |
| Storage scaling             | `specs/matrix-storage-architecture-review.md` | Tracked separately. Out of scope for ORA-219.                                      |
| Integration testing handoff | `specs/integration-testing-wave4-handoff.md`  | Context dump from the Wave-4 integration-test push.                                |
| Messages/Sessions testing   | `specs/messages-sessions-testing-spec.md`     | Test coverage spec for those modules.                                              |

## When the spec disagrees with code

The spec is the design, but the code is what runs. Where they disagree:

- **If the code has shipped:** the code is right. The spec may be stale or have lost a vote. Note the divergence in the relevant doc here and in a follow-up if it matters.
- **If the code hasn't shipped:** the spec is right. The code is wrong. Fix it.

Two examples of code diverging from the spec (and the docs correctly reflect the code):

- **Meta-tools shipped as two, not four.** Spec mentioned `find_capability`, `load_capability`, `list_capabilities`, `list_capability_details`. Implementation collapsed to `load_capability` (does discovery + load + manifest return) and `list_capabilities`. See [`architecture/meta-tools-and-discovery.md`](../architecture/meta-tools-and-discovery.md).
- **`tasks` and `calls` plugins are stubs.** Spec listed them as bundled. The stubs exist in `BUNDLED_PLUGINS` so feature toggles work, but full implementations are deferred — see `follow-ups.md` and the TASK-31 / TASK-18 status notes.

## Files in this folder

- [`ora-219-spec.md`](ora-219-spec.md) — pointer + one-paragraph reading guide.
- [`tasks-index.md`](tasks-index.md) — pointer + status snapshot.
- [`follow-ups.md`](follow-ups.md) — open items the spec deferred or the implementation discovered.

## When to update files in this folder

- **Spec changes:** edit the spec. Update the relevant doc here if the change invalidates something we documented.
- **A task moves from TODO to Done:** edit `specs/tasks/README.md` (the status table). The `tasks-index.md` pointer here doesn't need a refresh.
- **A new follow-up emerges:** append to `follow-ups.md`.
